import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function checkRelease(pkg, lock, tag) {
  const errors=[];
  if(pkg.name!=='js-superagent')errors.push('Unexpected package name');
  if(!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(pkg.version))errors.push('Unsupported release version');
  if(pkg.private)errors.push('Package is private');
  if(pkg.license!=='MIT'||lock.packages?.['']?.license!=='MIT')errors.push('License must be MIT');
  if(lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version||lock.name!==pkg.name)errors.push('Package and lock version/name differ');
  const channel=pkg.version.includes('-')?pkg.version.split('-')[1].split('.')[0]:'latest';
  if(pkg.publishConfig?.tag!==channel||pkg.publishConfig?.access!=='public'||pkg.publishConfig?.registry!=='https://registry.npmjs.org/')errors.push('Invalid registry/access/dist-tag');
  if(pkg.repository?.url!=='git+https://github.com/imjszhang/js-superagent.git')errors.push('Repository does not match release destination');
  if(tag&&tag!==`v${pkg.version}`)errors.push('Git tag does not match package version');
  for(const hook of ['install','postinstall','preinstall','prepare'])if(pkg.scripts?.[hook])errors.push(`Unexpected consumer lifecycle hook: ${hook}`);
  return {ok:!errors.length,errors,version:pkg.version,tag:channel};
}
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=checkRelease(JSON.parse(fs.readFileSync(path.join(root,'package.json'))),JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'))),process.env.RELEASE_TAG);
  if(!result.ok)throw new Error(result.errors.join('\n'));
  console.log(JSON.stringify(result));
}
