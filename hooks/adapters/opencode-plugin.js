// OpenCode adapter for coordinator-guard: in-process `tool.execute.before`; a deny throws.
// bootstrap.mjs agent-session --role coordinator|producer installs <checkout>/.opencode/plugins/coordinator-guard.js,
// which re-exports this plugin. CC_ROLE / CC_GUARD_MODE come from the OpenCode process env (OpenCode's
// shell tool filters env vars, so the guard must run here, not in a shell hook).
import { guard } from '../coordinator-guard.mjs';

export const CoordinatorGuard = async () => ({
  'tool.execute.before': async (input, output) => {
    const tool = String(input?.tool || '').toLowerCase();
    const args = output?.args || {};
    let payload = null;
    if (tool === 'bash') payload = { command: String(args.command || '') };
    else if (['edit', 'write', 'patch'].includes(tool) && (args.filePath || args.file_path)) payload = { filePath: String(args.filePath || args.file_path) };
    if (!payload) return;
    const { block, message } = guard('opencode', input?.sessionID, payload);
    if (block) throw new Error(message);
  },
});
