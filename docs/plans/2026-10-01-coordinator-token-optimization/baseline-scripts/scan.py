import json,os,glob,collections,re,sys
rows=[]
for f in glob.glob(os.path.expanduser('~/.omniroute/call_logs/*/*.json')):
    try: d=json.load(open(f))
    except: continue
    rb=d.get("requestBody") or {}
    if isinstance(rb,str):
        try: rb=json.loads(rb)
        except: rb={}
    if not isinstance(rb,dict): rb={}
    s=d.get('summary',{}); t=s.get('tokens',{}) or {}
    msgs=rb.get('messages') or rb.get('input') or []
    tools=rb.get('tools') or []
    names=[(x.get('name') or (x.get('function') or {}).get('name') or '') for x in tools if isinstance(x,dict)]
    sysj=json.dumps(rb.get('system') or rb.get('instructions') or '')
    allt=json.dumps(msgs)
    # identify session
    meta=json.dumps(rb.get('metadata') or {})
    sid=re.search(r'session_([0-9a-f-]{36})',meta)
    sid=sid.group(1) if sid else (rb.get('prompt_cache_key') or '')
    tags=[k for k in ['cocos-orca-fleet','game-producer','orca-agent-fleet','orchestration','worker_done','orca orchestration'] if k in allt[:400000]]
    # tool result sizes
    rows.append(dict(f=f,ts=s.get('timestamp'),model=s.get('requestedModel'),key=s.get('apiKeyName'),tin=t.get('in') or 0,cr=t.get('cacheRead') or 0,out=t.get('out') or 0,
      ntools=len(names),nfun=sum(1 for n in names if 'funplay' in n),nmcp=sum(1 for n in names if n.startswith('mcp__')),
      toolsB=len(json.dumps(tools)),sysB=len(sysj),msgB=len(allt),nmsg=len(msgs),sid=sid,tags=tags))
json.dump(rows,open('/tmp/omni/rows.json','w'))
print(len(rows))
