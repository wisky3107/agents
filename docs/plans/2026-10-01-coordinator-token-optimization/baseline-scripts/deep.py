import json,glob,os,collections,re
S=json.load(open('/tmp/omni/roles.json')) if False else None
import subprocess
# recompute per-session details for producer/fleet sessions
exec(open('/tmp/omni/role2.py').read().split("json.dump(S")[0])
for role in ['producer','fleet-orch','fleet-worker']:
    ss=[s for s in S if s['role']==role]
    cats=collections.Counter();cattok=collections.Counter();base=[];resb=collections.Counter()
    for s in ss:
        msgs={};res={}
        for line in open(s['f'],errors='ignore'):
            try:e=json.loads(line)
            except:continue
            if e.get('timestamp','')<since: continue
            m=e.get('message') or {}
            if e.get('type')=='assistant' and m.get('usage'):
                mid=m.get('id');msgs.setdefault(mid,{'u':m['usage'],'t':[]})
                for x in m.get('content') or []:
                    if x.get('type')=='tool_use': msgs[mid]['t'].append((x['id'],x['name'],json.dumps(x.get('input',{}))))
            if e.get('type')=='user' and isinstance(m.get('content'),list):
                for x in m['content']:
                    if x.get('type')=='tool_result': res[x.get('tool_use_id')]=len(json.dumps(x.get('content','')))
        first=True
        for mid,v in msgs.items():
            u=v['u'];c=(u.get('cache_read_input_tokens') or 0)+(u.get('cache_creation_input_tokens') or 0)+(u.get('input_tokens') or 0)
            if first: base.append(c);first=False
            for tid,n,a in v['t'] or [(None,'(text-only)','')]:
                if n=='Bash':
                    if re.search(r'orca terminal (read|wait)',a): k='orca terminal read/wait'
                    elif re.search(r'orca orchestration',a): k='orca orchestration *'
                    elif re.search(r'orca terminal send',a): k='orca terminal send'
                    elif re.search(r'orca (task|run)',a): k='orca task/run'
                    elif re.search(r'\borca\b',a): k='orca other'
                    elif re.search(r'sleep|until ',a): k='bash sleep/until'
                    elif re.search(r'git ',a): k='git'
                    elif re.search(r'HANDOFF|evidence|\.json',a): k='bash evidence/json'
                    else: k='bash other'
                else: k=n
                cats[k]+=1;cattok[k]+=c/len(v['t'] or [1]);resb[k]+=res.get(tid,0)
    print(f"== {role}: sessions={len(ss)} median first-turn ctx={sorted(base)[len(base)//2] if base else 0}")
    T=sum(cattok.values())
    for k,n in cats.most_common(14):
        print(f"   {k:28} calls={n:5} ctxM={cattok[k]/1e6:6.0f} ({cattok[k]/T*100:4.1f}%) avgResult={resb[k]//max(n,1):6}B")

print('----- sample orca other commands')
c=collections.Counter()
for s in S:
    if s['role'] not in('producer','fleet-worker','fleet-orch'): continue
    for line in open(s['f'],errors='ignore'):
        if '"tool_use"' not in line: continue
        try:e=json.loads(line)
        except:continue
        for x in (e.get('message') or {}).get('content') or []:
            if x.get('type')=='tool_use' and x['name']=='Bash':
                a=x['input'].get('command','')
                for mm in re.findall(r'orca\s+([a-z-]+(?:\s+[a-z-]+)?)',a): c[mm]+=1
for k,n in c.most_common(20): print(n,k)
