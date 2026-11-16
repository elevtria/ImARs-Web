import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {extname,basename} from 'node:path';
import {createRequire} from 'node:module';
const {encode,decode}=createRequire(new URL('../tmp/ar-tools/package.json',import.meta.url))('@msgpack/msgpack');
// Run read-unity-ar-assets.mjs and the documented MindAR compiler first.
const {targets}=JSON.parse(readFileSync('tmp/ar-tools/scene-data.json','utf8'));
const compiled=JSON.parse(readFileSync('tmp/ar-tools/compiled-targets.json','utf8'));
const converted=existsSync('scripts/teacher-ar-converted-models.json')?JSON.parse(readFileSync('scripts/teacher-ar-converted-models.json','utf8')):{};
const replacements={'Water_Cycle_Centered.glb':'water-cycle','Pumping._heart_final (1).glb':'heart','VulcanoSure.glb':'volcano','Orion_AR.glb':'orion','Freezing_Snowflake.glb':'snowflake','Fixed_Pulley.glb':'pulley','Traverse and Longitudinal Wave.glb':'waves','iceCube_melting_animation.glb':'melting-ice','Season of the Earth.glb':'earth','magnet2.glb':'magnet'};
const names=['Water cycle','Big Dipper','Rotting apple','Water and sound waves','Food web','Rusting nail','Wedge','Screw','Longitudinal and transverse waves','Circulation','Melting ice','Blood flow','Polaris','Heart','Volcano','Seasons','Tearing paper','Freezing','Solar and lunar eclipses','Magnetic separation','Orion','Axle','Pulley','Inclined plane','Constellations','Lever','Wheel'];
const topicMap={'CHANGE OF STATE':'Changes of state','PHYSICAL AND CHEMICAL CHANGES':'Physical and chemical changes','CIRCULATORY':'The circulatory system','PROPERTIES OF WATER AND SOUND':'Properties of water and sound','FOODWEB':'Food webs','SIMPLEMACHINE':'Simple machines','TRAVERSE AND LONGITUDINAL WAVE':'Longitudinal and transverse waves','VOLCANIC ACTIVITY':'Volcanic activity','MOTION OF THE EARTH':'Motion of the Earth','CONSTELLATION':'Constellations','SEPARATION TECHNIQUES':'Mixtures and separation techniques'};
mkdirSync('assets/teacher-ar',{recursive:true});
function copy(path){const input=readFileSync(path);if(input.length>25*1024*1024)throw Error(`Asset too large: ${path}`);const hash=createHash('sha256').update(input).digest('hex').slice(0,16),output=`assets/teacher-ar/asset-${hash}${extname(path).toLowerCase()}`;if(!existsSync(output))writeFileSync(output,input);return `/${output}`;}
const catalog=targets.map((target,index)=>{
  const modelAsset=path=>({url:replacements[basename(path)]?`/assets/showcase/${replacements[basename(path)]}.glb`:copy(path),name:basename(path,extname(path))});
  const models=(target.dissection?[target.dissection.whole]:target.models).map(modelAsset);
  const folder=target.models[0].split(/[\\/]/).find((part,i,parts)=>parts[i-1]==='3d MODELS');
  const tracking=compiled[target.name];
  let dissection;
  if(target.dissection){const source=target.dissection.cutaway;let model;if(extname(source)==='.fbx'){const prepared=converted[basename(source)];if(!prepared||prepared.sourceHash!==createHash('sha256').update(readFileSync(source)).digest('hex')||!existsSync('.'+prepared.url))throw Error('Prepare the mobile heart cutaway with scripts/prepare-teacher-heart.py first.');model={url:prepared.url,name:basename(source,extname(source))};}else model=modelAsset(source);if(target.dissection.kind==='volcano')model.root='Original volcano BACK half';dissection={kind:target.dissection.kind,model};}
  return {id:`model-${index+1}`,title:names[index],topic:topicMap[folder],markerName:target.name,marker:copy(target.image),target:typeof tracking==='string'?tracking:tracking.url,targetCount:tracking.count||1,markerSources:tracking.sources||[],models,
    ...(dissection?{dissection}:{}),labels:target.bindings.map((binding,i)=>({id:`label-${i+1}`,title:binding.title,description:binding.description||'',audio:binding.narration?copy(binding.narration):null,interactiveAudio:binding.interactiveNarration?copy(binding.interactiveNarration):null,descriptionCues:binding.descriptionCues||[],question:binding.question||'',answer:binding.answer||'',answerStart:binding.answerStart||0,parts:binding.targets.map(t=>({path:t.path||'',point:t.normalizedPoint||{x:0,y:0,z:0},...(t.model?{model:basename(t.model,extname(t.model))}:{})}))}))};
});
const dataList=[],targetModels=[];
for(const item of catalog) {
  const data=decode(readFileSync('.'+item.target)).dataList;
  dataList.push(...data); targetModels.push(...data.map(()=>item.id));
}
const bytes=encode({v:2,dataList}), path=`assets/teacher-ar/scanner-${createHash('sha256').update(bytes).digest('hex').slice(0,16)}.mind`;
writeFileSync(path,bytes);
const scanner={target:`/${path}`,targetModels};
writeFileSync('js/teacher-ar-catalog.js',`// Generated from the app's SCENEAR image targets, models, and narration. Public teaching assets only.\nexport const teacherARCatalog = ${JSON.stringify(catalog,null,2)};\nexport const teacherARScanner = ${JSON.stringify(scanner,null,2)};\n`);
console.log(`Prepared ${catalog.length} marker experiences, ${catalog.reduce((n,item)=>n+item.labels.length,0)} original description/narration cards.`);
