import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,extname} from 'node:path';
import {parseAllDocuments} from 'yaml';
const project = process.argv[2];
if (!project) throw new Error('Pass the Unity project Assets directory.');
const root = project;
const scene=readFileSync(join(root,'SCENEAR.unity'),'utf8');
const selected=[...scene.matchAll(/^--- !u!(\d+) &(-?\d+)[^\n]*\n([\s\S]*?)(?=^--- !u!|$(?![\s\S]))/gm)].filter(m=>['1','4','1001'].includes(m[1])||/^  (mRuntimeTexture|bindings|wholeHeartModel|wholeModel):/m.test(m[3])).map(m=>`---\n__id: "${m[2]}"\n${m[3]}`).join('\n');
const docs=parseAllDocuments(selected,{uniqueKeys:false}).map(doc=>{if(doc.errors.length)throw doc.errors[0];return doc.toJSON()});
const meta=new Map();
function visit(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())visit(path);else if(item.name.endsWith('.meta')){const asset=path.slice(0,-5);if(!['.glb','.fbx','.png','.jpg','.jpeg','.mp3','.wav','.ogg'].includes(extname(asset)))continue;const guid=readFileSync(path,'utf8').match(/^guid: (\w+)/m)?.[1];if(guid)meta.set(guid,asset);}}}
visit(root);
const objects=new Map(docs.map(d=>[Number(d.__id),d]));
const transforms=docs.filter(d=>d.Transform).map(d=>({id:Number(d.__id),...d.Transform}));
const targets=docs.filter(d=>d.MonoBehaviour?.mRuntimeTexture).map(d=>({name:d.MonoBehaviour.mTrackableName,image:meta.get(d.MonoBehaviour.mRuntimeTexture.guid),object:d.MonoBehaviour.m_GameObject.fileID, transform:transforms.find(t=>t.m_GameObject?.fileID===d.MonoBehaviour.m_GameObject.fileID)?.id}));
const bindings=docs.flatMap(d=>d.MonoBehaviour?.bindings||[]).filter(b=>b.title).map(b=>({title:b.title,description:b.subtitle,narration:meta.get(b.narration?.guid),interactiveNarration:meta.get(b.interactiveNarration?.guid),descriptionCues:b.narrationDescription||[],question:b.narrationQuestion||'',answer:b.narrationAnswer||'',answerStart:b.narrationAnswerStart||0,targets:b.targets}));
function ancestry(id){const result=[];for(let i=0;id&&i<30;i++){result.push(id);const t=objects.get(id)?.Transform;if(!t)break;id=t.m_Father?.fileID||objects.get(t.m_PrefabInstance?.fileID)?.PrefabInstance?.m_Modification?.m_TransformParent?.fileID;}return result;}
// Image targets can contain other image targets in the scene hierarchy. Their
// models and narration belong to the nearest target, never to every ancestor.
const markerTransforms=new Set(targets.map(target=>target.transform));
const markerOwner=id=>ancestry(id).find(parent=>markerTransforms.has(parent));
const sourceModel=object=>meta.get(object?.m_CorrespondingSourceObject?.guid||objects.get(object?.m_PrefabInstance?.fileID)?.PrefabInstance?.m_SourcePrefab?.guid);
const objectOwner=id=>markerOwner(transforms.find(t=>t.m_GameObject?.fileID===id)?.id||objects.get(objects.get(id)?.GameObject?.m_PrefabInstance?.fileID)?.PrefabInstance?.m_Modification?.m_TransformParent?.fileID);
for(const target of targets){target.bindings=bindings.filter(b=>b.targets?.some(t=>markerOwner(t.root?.fileID)===target.transform)).map(b=>({...b,targets:b.targets.filter(t=>markerOwner(t.root?.fileID)===target.transform)}));target.models=[...new Set(docs.filter(d=>d.PrefabInstance&&markerOwner(d.PrefabInstance.m_Modification?.m_TransformParent?.fileID)===target.transform).map(d=>meta.get(d.PrefabInstance.m_SourcePrefab?.guid)).filter(path=>path&&extname(path)==='.glb'))];
  const dissection=docs.map(d=>d.MonoBehaviour).find(m=>m?.wholeHeartModel&&objectOwner(m.wholeHeartModel.fileID)===target.transform);
  if(dissection){target.dissection={kind:'heart',whole:sourceModel(objects.get(dissection.wholeHeartModel.fileID)?.GameObject),cutaway:sourceModel(objects.get(dissection.dissectedHeartModel.fileID)?.GameObject)};for(const binding of target.bindings)binding.targets=binding.targets.map(t=>({...t,model:sourceModel(objects.get(t.root?.fileID)?.Transform)}));}
  const volcano=docs.map(d=>d.MonoBehaviour).find(m=>m?.wholeModel&&m.cutawayModel&&markerOwner(m.wholeModel.fileID)===target.transform);
  if(volcano)target.dissection={kind:'volcano',whole:sourceModel(objects.get(volcano.wholeModel.fileID)?.Transform),cutaway:sourceModel(objects.get(volcano.cutawayModel.fileID)?.Transform)};
}
writeFileSync('tmp/ar-tools/scene-data.json',JSON.stringify({targets,bindings},null,2));
console.log(`Read ${targets.length} original Unity marker experiences.`);
