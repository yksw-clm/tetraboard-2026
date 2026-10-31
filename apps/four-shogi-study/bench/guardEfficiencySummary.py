"""保存済みの証明効率比較を再集計し、期限超過と未観測範囲を分けます。"""
import pathlib,json,statistics,collections,math,sys
if len(sys.argv)!=2: raise SystemExit('Usage: python3 guardEfficiencySummary.py <ARTIFACT_ROOT>')
root=pathlib.Path(sys.argv[1])
read=lambda p:json.loads(p.read_text())
memory_points=[]
resource_dir=root/'profiles/runtime-resource/diagnostics'
if (resource_dir/'guard-ready.json').exists() and (resource_dir/'resources.jsonl').exists():
 clock_file=root/'validation/resource-clock-calibration.json'
 if clock_file.exists():clock=read(clock_file)
 else:
  clock={'monitorStartEpochApproxMs':(resource_dir/'guard-ready.json').stat().st_mtime_ns/1000000,'method':'guard-ready native file mtime approximates monitor monotonic start; preserve this calibration after ZIP extraction','interiorTrimMs':100,'savedSampleCadenceMs':1000,'monitorPeakCadenceMs':100}
  clock_file.write_text(json.dumps(clock,indent=2)+'\n')
 memory_points=[(clock['monitorStartEpochApproxMs']+x['elapsedSeconds']*1000,x['rssBytes']['total']) for x in [json.loads(s) for s in (resource_dir/'resources.jsonl').read_text().splitlines() if s]]
def quantile(xs,p):
 xs=sorted(xs);return xs[max(0,math.ceil(len(xs)*p)-1)] if xs else None
def summarize(rows):
 guards=[r['guard'] for r in rows if r.get('guard')]
 candidates=[c for g in guards for c in g['rows']]
 reasons=collections.Counter(c.get('stopReason','unrecorded') for c in candidates if c['status']=='unknown')
 stages=collections.Counter(); metrics=collections.Counter()
 for g in guards:
  stages.update(g.get('stagesMs',{}))
  for c in g['rows']:
   if c.get('proof'):metrics.update(c['proof'].get('metrics') or {})
 complete=sum(c['status']!='unknown' for c in candidates)
 incumbent=[next((c for c in g['rows'] if c['action']==g['originalAction']),None) for g in guards]
 safeAlt=[any(c['status']=='safe' and c['action']!=g['originalAction'] and c['candidate'] is not None for c in g['rows']) for g in guards]
 roles=collections.defaultdict(collections.Counter)
 for c in candidates:roles['incumbent' if c['maxNRank']==1 else c['source']][c['status']]+=1
 result={'cases':len(rows),'targets':len(candidates),'complete':complete,'unknown':len(candidates)-complete,
  'safe':sum(c['status']=='safe' for c in candidates),'unsafe':sum(c['status']=='unsafe' for c in candidates),'statusesByRole':{k:dict(v) for k,v in roles.items()},
  'completionRate':complete/len(candidates) if candidates else None,'unknownReasons':dict(reasons),
  'incumbentTargets':sum(c is not None for c in incumbent),'incumbentUnsafe':sum(c is not None and c['status']=='unsafe' for c in incumbent),'safeAlternative':sum(safeAlt),
  'unsafeAndSafePair':sum(c is not None and c['status']=='unsafe' and a for c,a in zip(incumbent,safeAlt)),
  'changed':sum(g['changed'] for g in guards),'wouldChange':sum(g['wouldChange'] for g in guards),
  'cacheLookups':sum(g.get('cacheStats',{}).get('lookups',0) for g in guards),'cacheHits':sum(g.get('cacheStats',{}).get('hits',0) for g in guards),
  'cachePeakBytes':max([g.get('cacheStats',{}).get('peakBytes',0) for g in guards] or [0]),'stageTotalsMs':dict(stages),'proofMetricTotals':dict(metrics),
  'guardP50Ms':quantile([g['elapsedMs'] for g in guards],.5),'guardP95Ms':quantile([g['elapsedMs'] for g in guards],.95),
  'guardWorkMean':statistics.mean([g['work'] for g in guards]) if guards else 0,'guardTransitions':sum(g['transitions'] for g in guards)}
 live=[r for r in rows if 'snapshot' in r]
 if live:
  nonforced=[r for r in live if not r['forced']]
  depth=lambda r:r.get('guard',{}).get('maxNCompletedDepth',r['snapshot']['completedDepth'])
  deep=lambda r:r['snapshot'].get('timing',{}).get('deepStartedMs') is not None
  sampled=[r['rssInteriorSampleMaxBytes'] for r in live if r.get('rssInteriorSampleMaxBytes') is not None]
  result.update({'rssInteriorSampleMaxBytes':max(sampled) if sampled else None,'rssUnobservedInteriorWindows':len(live)-len(sampled),'rssScope':'1s saved samples inside response windows trimmed100ms at both ends; not a strict condition peak. Overall monitor peak is100ms.',
   'responseP50Ms':quantile([r['responseMs'] for r in live],.5),'responseP95Ms':quantile([r['responseMs'] for r in live],.95),
   'guardReportsMissing':sum(r['condition']['guard']['mode']!='off' and not r.get('guard') for r in live),'over2000Ms':sum(r['responseMs']>2000 for r in live),'maxResponseMs':max(r['responseMs'] for r in live),'normalWorkMean':statistics.mean(r['snapshot']['work'] for r in live),
   'normalNodesMean':statistics.mean(r['snapshot']['nodes'] for r in live),'nonforced':len(nonforced),'normalDepthMedian':statistics.median(depth(r) for r in nonforced) if nonforced else None,
   'normalDepthTwo':sum(depth(r)>=2 for r in nonforced),'deepStarted':sum(deep(r) for r in nonforced),
   'guardControlChanges':[r['caseId'] for r in live if r['kind']=='win-control' and r.get('guard',{}).get('changed')],
   'changes':[{'caseId':r['caseId'],'action':r['snapshot']['recommendedAction'],'oldAction':r.get('guard',{}).get('originalAction')} for r in live if r.get('guard',{}).get('changed')]})
 return result

groups=collections.defaultdict(list); case_details=[]
for file in sorted((root/'diagnostics').glob('*.json')):
 if not file.name.endswith(('-runtime.json','-frozen-results.json')):continue
 a=read(file)
 if not a['complete']:continue
 for row in a['rows']:
  kind='runtime' if 'snapshot' in row else 'frozen'
  condition=row['condition']['name'] if kind=='runtime' else row['variant']+'-'+str(row['budgetMs'])
  r={**row,'caseId':a['caseId'],'kind':a['kind'],'forced':a.get('forced',False)}
  if kind=='runtime' and row['snapshot'].get('lethalGuard'):r['guard']=row['snapshot']['lethalGuard']
  if kind=='runtime':
   samples=[v for t,v in memory_points if row['startWall']+100<=t<=row['endWall']-100]
   r['rssInteriorSampleMaxBytes']=max(samples) if samples else None
  groups[(kind,a['warm'],condition)].append(r)
  if a['caseId'] in ['ae960d72d889183a-95','f1c8fdef9f37da03-146']:
   g=r.get('guard');case_details.append({'phase':kind,'warm':a['warm'],'caseId':a['caseId'],'condition':condition,'responseMs':r.get('responseMs'),
    'changed':g.get('changed') if g else False,'wouldChange':g.get('wouldChange') if g else False,
    'rows':[{k:c.get(k) for k in ['actionId','maxNRank','source','status','queryBudgetMs','elapsedMs','stopReason']} for c in g['rows']] if g else []})
result={'reference':'7338e7d24574b336a4c4e3df43c7971039122dc6','mainSource':read(root/'runtime-plan.json')['source'] if (root/'runtime-plan.json').exists() else None,
 'groups':[{'phase':k[0],'warm':k[1],'condition':k[2],**summarize(v)} for k,v in sorted(groups.items())],
 'known':case_details,'aliases':read(root/'runtime-plan.json').get('aliases',{}) if (root/'runtime-plan.json').exists() else {},'runtimeExecuted':(root/'runtime-checkpoint.json').exists(),'scope':'Used correlated seed9874100, no new games or independent strength certification. Frozen extra diagnostic time and live total2s remain separate.'}
quality=root/'validation/quality.json'
if quality.exists():
 q=read(quality);cond=collections.defaultdict(list)
 for r in q['rows']:cond[r['condition']].append(r)
 result['quality']={'complete':q['complete'],'source':q['source'],'conditions':{k:{'count':len(v),'accepted':sum(r['accepted'] for r in v),'criticalCount':sum(r['critical'] for r in v),'criticalAccepted':sum(r['critical'] and r['accepted'] for r in v),'failed':[r['id'] for r in v if not r['accepted']],'guardChanges':sum(r['snapshot'].get('lethalGuard',{}).get('changed',False) for r in v)} for k,v in cond.items()},'fixed':[{k:r[k] for k in ['id','strategy','accepted']} for r in q['fixed']]}
resources={}
for p in (root/'profiles').glob('*-resource/diagnostics/resource-summary.json'):resources[p.parts[-3]]=read(p)
result['resources']=resources
for name in ['measurement-closure.json','validation/runtime-budget-audit.json','validation/quality-budget-audit.json','validation/critical-timeout-analysis.json','validation/serialized.json','validation/off-body-identity.json']:
 p=root/name
 if p.exists():result.setdefault('audits',{})[name]=read(p)
(root/'analysis-summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'runtimeGroups':sum(g['phase']=='runtime' for g in result['groups']),'frozenGroups':sum(g['phase']=='frozen' for g in result['groups'])}))
