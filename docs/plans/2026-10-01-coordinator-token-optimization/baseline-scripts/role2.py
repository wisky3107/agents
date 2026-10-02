import json,glob,os,collections,datetime,re
since='2026-09-24'
S=[]
files=glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True)
for f in files:
    if os.path.getmtime(f)<datetime.datetime(2026,9,24).timestamp(): continue
    seen=set();turns=[];first='';pending={}
    msgs={}
    for line in open(f,errors='ignore'):
        try:e=json.loads(line)
        except:continue
        if e.get('timestamp','')<since: continue
        m=e.get('message') or {}
        if e.get('type')=='user':
            c=m.get('content')
            if isinstance(c,list):
                txt=' '.join(x.get('text','') for x in c if x.get('type')=='text')
            else: txt=c or ''
            if txt and not txt.startswith('<local-command') and len(first)<20000: first+=' || '+txt[:4000]
        if e.get('type')=='assistant' and m.get('usage'):
            mid=m.get('id') or e.get('uuid')
            if mid not in msgs: msgs[mid]={'u':m['usage'],'tools':[]}
            for x in m.get('content') or []:
                if x.get('type')=='tool_use':
                    inp=x.get('input',{})
                    msgs[mid]['tools'].append((x['name'],json.dumps(inp)[:400]))
    if not msgs: continue
    ctx=[];poll=0;polltok=0
    for mid,v in msgs.items():
        u=v['u'];c=(u.get('cache_read_input_tokens') or 0)+(u.get('cache_creation_input_tokens') or 0)+(u.get('input_tokens') or 0)
        ctx.append((c,u.get('cache_creation_input_tokens') or 0,u.get('output_tokens') or 0))
        s=' '.join(n+a for n,a in v['tools'])
        if re.search(r'orca (terminal (read|wait)|orchestration (check|inbox|wait|messages)|task (list|show|status))|\bsleep\b|Monitor|ScheduleWakeup|tail -[nf]|wait-for|worker_done',s) and not re.search(r'Edit|Write',s):
            poll+=1;polltok+=c
    fl=first.lower()
    fl=fl.replace('before performing any task in this session','').replace('agents.md loaded','')
    if 'you are the game-producer' in fl or 'resume game-producer' in fl or ('game-producer' in fl and 'producer' in fl[:20000]): role='producer'
    elif 'cocos-orca-fleet orchestrator' in fl or 'orchestrator for' in fl: role='fleet-orch'
    elif 'dispatched worker' in fl: role='fleet-worker'
    elif 'writer and editor-lock' in fl or 'you are the writer' in fl or 'you are the reviewer' in fl or 'you are the planner' in fl: role='slice-agent'
    elif 'before performing any task in this session' in fl or 'agents.md loaded' in fl: role='orca-spawned(boot)'
    elif '/subagents/' in f: role='subagent'
    else: role='interactive'
    S.append(dict(f=f,role=role,n=len(ctx),tot=sum(c for c,_,_ in ctx),cw=sum(w for _,w,_ in ctx),out=sum(o for _,_,o in ctx),poll=poll,polltok=polltok,first=first[:3000]))
json.dump(S,open('/tmp/omni/roles.json','w'))
tot=sum(s['tot'] for s in S)
print('dedup total ctx M',round(tot/1e6),'sessions',len(S))
g=collections.defaultdict(lambda:collections.Counter())
for s in S:
    a=g[s['role']];a['sess']+=1;a['turns']+=s['n'];a['tot']+=s['tot'];a['cw']+=s['cw'];a['out']+=s['out'];a['poll']+=s['poll'];a['polltok']+=s['polltok']
for r,a in sorted(g.items(),key=lambda x:-x[1]['tot']):
    print(f"{r:20} sess={a['sess']:4} turns={a['turns']:6} ctxM={a['tot']/1e6:7.0f} ({a['tot']/tot*100:4.1f}%) avgCtx={a['tot']//a['turns']:6} cwM={a['cw']/1e6:5.0f} outM={a['out']/1e6:4.1f} pollTurns={a['poll']:5} ({a['poll']/a['turns']*100:3.0f}%) pollCtxM={a['polltok']/1e6:5.0f}")
