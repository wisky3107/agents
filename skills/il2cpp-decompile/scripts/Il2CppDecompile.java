// Names every IL2CPP method from a build_symbols.py table, then decompiles the
// rows flagged for decompilation into one .c file per original C# source file.
// Args: <symbols.tsv> <out dir> <path to the original .so> [labels.tsv]
//@category IL2CPP

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

import ghidra.app.cmd.disassemble.ArmDisassembleCommand;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.decompiler.*;
import ghidra.app.decompiler.parallel.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.data.PointerDataType;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.util.task.TaskMonitor;

public class Il2CppDecompile extends GhidraScript {

	static class Row {
		long rva, len;
		String name, asm, file, sig;
		boolean decompile;
	}

	@Override
	protected void run() throws Exception {
		String[] args = getScriptArgs();
		Path tsv = Paths.get(args[0]);
		Path outDir = Paths.get(args[1]);
		Path so = Paths.get(args[2]);

		List<Row> rows = new ArrayList<>();
		for (String line : Files.readAllLines(tsv, StandardCharsets.UTF_8)) {
			String[] c = line.split("\t", -1);
			Row r = new Row();
			r.rva = Long.parseLong(c[0], 16);
			r.len = Long.parseLong(c[1], 16);
			r.name = c[2];
			r.asm = c[3];
			r.file = c[4];
			r.sig = c[5];
			r.decompile = c[6].equals("1");
			rows.add(r);
		}

		long delta = findDelta(so, rows.get(rows.size() / 2).rva);
		println("Rows: " + rows.size() + ", address delta: 0x" + Long.toHexString(delta));
		AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();

		// Disassemble only inside known method bodies, so literal pools and
		// neighbouring methods are never swallowed. 32-bit ARM is forced to ARM
		// mode (Unity armeabi-v7a IL2CPP code is not Thumb).
		AddressSet bodies = new AddressSet();
		AddressSet entries = new AddressSet();
		for (Row r : rows) {
			Address a = space.getAddress(r.rva + delta);
			entries.add(a);
			bodies.add(a, a.add(Math.max(r.len, 4) - 1));
		}
		monitor.setMessage("Disassembling");
		disassembler(entries, bodies).applyTo(currentProgram, monitor);

		monitor.setMessage("Creating functions");
		Listing listing = currentProgram.getListing();
		Map<Function, Row> wanted = new LinkedHashMap<>();
		int created = 0, failed = 0;
		for (Row r : rows) {
			monitor.checkCancelled();
			Address a = space.getAddress(r.rva + delta);
			AddressSet body = new AddressSet(a, a.add(Math.max(r.len, 4) - 1));
			try {
				Function f = listing.getFunctionAt(a);
				if (f == null) {
					for (Function o : listing.getFunctions(body, true)) {
						listing.removeFunction(o.getEntryPoint());
					}
					f = listing.createFunction(r.name, a, body, SourceType.IMPORTED);
				}
				else {
					f.setName(r.name, SourceType.IMPORTED);
				}
				created++;
				if (r.decompile) {
					wanted.put(f, r);
				}
			}
			catch (Exception e) {
				failed++;
			}
		}
		println("Functions named: " + created + ", failed: " + failed + ", to decompile: " + wanted.size());

		if (args.length > 3) {
			applyLabels(Paths.get(args[3]), space, delta);
		}

		Map<Row, String> results = new ConcurrentHashMap<>();
		DecompilerCallback<Void> cb = new DecompilerCallback<>(currentProgram, decompiler -> {
			DecompileOptions opts = new DecompileOptions();
			opts.grabFromProgram(currentProgram);
			decompiler.setOptions(opts);
			decompiler.toggleCCode(true);
			decompiler.toggleSyntaxTree(false);
			decompiler.setSimplificationStyle("decompile");
		}) {
			@Override
			public Void process(DecompileResults res, TaskMonitor m) {
				Row r = wanted.get(res.getFunction());
				DecompiledFunction df = res.getDecompiledFunction();
				results.put(r, df != null ? df.getC()
						: "/* decompile failed: " + res.getErrorMessage() + " */\n");
				return null;
			}
		};
		cb.setTimeout(60);
		monitor.setMessage("Decompiling");
		try {
			ParallelDecompiler.decompileFunctions(cb, wanted.keySet(), monitor);
		}
		finally {
			cb.dispose();
		}

		Map<String, List<Row>> byFile = new TreeMap<>();
		for (Row r : wanted.values()) {
			byFile.computeIfAbsent(r.file, k -> new ArrayList<>()).add(r);
		}
		for (Map.Entry<String, List<Row>> e : byFile.entrySet()) {
			Path out = outDir.resolve(e.getKey().replaceAll("\\.cs$", ".c"));
			Files.createDirectories(out.getParent());
			try (Writer w = Files.newBufferedWriter(out, StandardCharsets.UTF_8)) {
				w.write("// Decompiled from libil2cpp.so (ARMv7) by Ghidra; names from Cpp2IL.\n");
				w.write("// Source: " + e.getKey() + "\n\n");
				for (Row r : e.getValue()) {
					w.write("// " + r.sig + "\n");
					w.write("// RVA 0x" + Long.toHexString(r.rva) + "  Length 0x" + Long.toHexString(r.len) + "\n");
					w.write(results.getOrDefault(r, "/* not decompiled */\n"));
					w.write("\n");
				}
			}
		}
		println("Decompiled " + results.size() + " functions into " + byFile.size() + " files under " + outDir);
	}

	/** Applies build_labels.py rows: F = extra function entries, D = data labels. */
	private void applyLabels(Path tsv, AddressSpace space, long delta) throws Exception {
		monitor.setMessage("Applying labels");
		Listing listing = currentProgram.getListing();
		SymbolTable symbols = currentProgram.getSymbolTable();
		int funcs = 0, data = 0, failed = 0;
		for (String line : Files.readAllLines(tsv, StandardCharsets.UTF_8)) {
			monitor.checkCancelled();
			String[] c = line.split("\t", -1);
			if (c.length < 3 || c[0].isEmpty()) {
				continue;
			}
			Address a = space.getAddress(Long.parseLong(c[0], 16) + delta);
			String name = c[2];
			try {
				if (c[1].equals("F")) {
					Function f = listing.getFunctionAt(a);
					if (f != null) {
						f.setName(name, SourceType.IMPORTED);
					}
					else {
						disassembler(new AddressSet(a), null).applyTo(currentProgram, monitor);
						new CreateFunctionCmd(name, a, null, SourceType.IMPORTED)
								.applyTo(currentProgram, monitor);
						f = listing.getFunctionAt(a);
					}
					// Callers of a thunk display the thunked function's name.
					Function target = f != null && f.isThunk() ? f.getThunkedFunction(true) : null;
					if (target != null && target.getSymbol().getSource() == SourceType.DEFAULT) {
						target.setName(name, SourceType.IMPORTED);
					}
					funcs++;
				}
				else {
					Symbol s = symbols.createLabel(a, name, SourceType.IMPORTED);
					s.setPrimary();
					if (listing.getDefinedDataAt(a) == null && listing.getInstructionAt(a) == null) {
						try {
							listing.createData(a, PointerDataType.dataType);
						}
						catch (Exception ignored) {
							// Overlapping data; the label alone still names the reference.
						}
					}
					data++;
				}
			}
			catch (Exception e) {
				failed++;
			}
		}
		println("Labels applied: " + funcs + " functions, " + data + " data, failed: " + failed);
	}

	private DisassembleCommand disassembler(AddressSetView start, AddressSetView restrict) {
		boolean arm32 = currentProgram.getLanguage().getProcessor().toString().equals("ARM");
		return arm32 ? new ArmDisassembleCommand(start, restrict, false)
				: new DisassembleCommand(start, restrict, true);
	}

	/** Finds the program-address offset that maps file RVA onto identical bytes. */
	private long findDelta(Path so, long rva) throws Exception {
		byte[] want = new byte[16];
		try (RandomAccessFile f = new RandomAccessFile(so.toFile(), "r")) {
			f.seek(rva);
			f.readFully(want);
		}
		AddressSpace space = currentProgram.getAddressFactory().getDefaultAddressSpace();
		long base = currentProgram.getImageBase().getOffset();
		for (long d : new long[] { 0, base, 0x10000, 0x100000 }) {
			byte[] got = new byte[16];
			try {
				currentProgram.getMemory().getBytes(space.getAddress(rva + d), got);
			}
			catch (Exception e) {
				continue;
			}
			if (Arrays.equals(want, got)) {
				return d;
			}
		}
		throw new IllegalStateException("Could not map RVA 0x" + Long.toHexString(rva) + " into the program");
	}
}
