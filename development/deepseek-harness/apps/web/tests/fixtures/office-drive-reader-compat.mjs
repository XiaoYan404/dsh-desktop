/** Built office readers preserve legacy Drive data and reject unsupported replacement receipts. */
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {copyFile,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {basename,join,resolve,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'

const repo=fileURLToPath(new URL('../../../../',import.meta.url))
const base=pathToFileURL(join(repo,'packages/enterprise/office/lib/types/drive-uploads.js')).href
const load=name=>import(import.meta.resolve(name,base))
const {Context}=await load('@deepseek-ai/cordis')
const {default:Storage}=await load('@deepseek-ai/dsh-storage')
const StorageJson=await load('@deepseek-ai/dsh-storage-json')
const StorageDomain=await load('@deepseek-ai/dsh-storage-domain')
const {default:Office}=await load('@deepseek-ai/dsh-enterprise-office')
const {executeOfficeRequest}=await import(new URL('request.js',base))
const {officeDriveDomain}=await import(new URL('drive.js',base))
const {officeDriveUploadDomain}=await import(base)
const frozenPath=new URL('./office-drive-before-versions.mjs',import.meta.url)
const digest=value=>createHash('sha256').update(value).digest('hex')
const frozenSha256='378cf938482b05daa628f4e600a7e17786df9f29156363836e22dafd5f4d2b1e'
const frozenBytes=await readFile(frozenPath)
assert.equal(digest(frozenBytes),frozenSha256,'Do not rewrite the frozen reader')
const root=await mkdtemp(join(tmpdir(),'dsh-office-drive-readers-'))
const live=new Context()
try{
 const relocated=frozenBytes.toString('utf8').replace(/from ["'](zod|@deepseek-ai\/dsh-brand|@deepseek-ai\/dsh-storage-domain)["']/g,
  (_match,name)=>`from ${JSON.stringify(import.meta.resolve(name,base))}`)
 const oldPath=join(root,'frozen-reader.mjs')
 await writeFile(oldPath,relocated)
 const previous=await import(pathToFileURL(oldPath).href)
 const dataRoot=join(root,'live')
 await live.plugin(Storage)
 await live.plugin(StorageJson,{root:dataRoot})
 await live.plugin(StorageDomain,{backend:'json'})
 await live.plugin(Office,{companyName:'Drive reader fixture',timeZone:'Asia/Shanghai',dshHome:root,members:[
  {id:'admin',name:'Administrator',department:'Office',jobTitle:'Administrator',role:'admin'},
  {id:'lin',name:'Lin',department:'Office',jobTitle:'Employee',role:'employee'},
  {id:'chen',name:'Chen',department:'Office',jobTitle:'Employee',role:'employee'},
 ]})
 const password='Drive reader fixture passphrase!'
 await live.office.initializeIdentity('admin',password)
 for(const member of ['lin','chen'])await live.office.setIdentityPassword('admin',member,password)
 const lin=await live.office.login({memberId:'lin',password})
 const chen=await live.office.login({memberId:'chen',password})
 const request=(session,method,args)=>executeOfficeRequest(live.office,session.token,{method,args})
 const original=Buffer.from('Immutable original bytes\n')
 const file=await live.office.uploadDriveFile('lin',{space:'private',folderId:null,name:'versions.txt',requestId:randomUUID(),
  mediaType:'text/plain',byteLength:original.length,dataBase64:original.toString('base64')})
 const old=await live.office.driveFileInfo('lin',file.id)
 await live.office.beginDriveUpload('lin',{space:'private',folderId:null,name:'legacy-pending.txt',requestId:randomUUID(),
  mediaType:'text/plain',byteLength:1,sha256:digest(Buffer.from('a'))})
 const cases=[['drive','enterprise_office_drive',officeDriveDomain,previous.officeDriveDomain],
  ['uploads','enterprise_office_uploads',officeDriveUploadDomain,previous.officeDriveUploadDomain]]
 for(const [kind,name]of cases)await copyFile(join(dataRoot,`${name}.json`),join(root,`before-${kind}.json`))
 const bytes=Buffer.from('New immutable version\0')
 let ticket=await request(lin,'beginDriveUpload',[{space:'private',folderId:null,name:file.name,requestId:randomUUID(),
  mediaType:'application/octet-stream',byteLength:bytes.length,sha256:digest(bytes),target:{id:file.id,revision:file.revision}}])
 ticket=await request(lin,'appendDriveUpload',[{uploadId:ticket.id,index:0,sha256:digest(bytes),dataBase64:bytes.toString('base64')}])
 await request(lin,'completeDriveUpload',[ticket.id])
 const history=await request(lin,'driveHistory',[file.id])
 assert.equal(history.versions.length,2)
 const info=await request(lin,'driveVersionInfo',[file.id,old.versionId])
 assert.equal(info.mediaType,'text/plain')
 const range=await request(lin,'downloadDriveRange',[{id:file.id,versionId:old.versionId,offset:0,byteLength:original.length}])
 assert.deepEqual(Buffer.from(range.dataBase64,'base64'),original)
 await assert.rejects(request(chen,'driveHistory',[file.id]),{code:'not_found'})
 await assert.rejects(executeOfficeRequest(live.office,chen.token,{method:'driveHistory',args:[file.id],actorId:'lin'}),{code:'invalid_input'})
 const trashed=await request(lin,'changeDriveLifecycle',[{id:file.id,revision:history.entry.revision,action:'trash'}])
 assert.equal((await request(lin,'driveTrash',[])).entries[0].id,file.id)
 await assert.rejects(request(lin,'driveVersionInfo',[file.id,old.versionId]),{code:'not_found'})
 for(const [kind,name]of cases)await copyFile(join(dataRoot,`${name}.json`),join(root,`after-${kind}.json`))
 await request(lin,'changeDriveLifecycle',[{id:file.id,revision:trashed.revision,action:'restore'}])
 assert.equal((await request(lin,'driveHistory',[file.id])).versions.length,2)
 await live.fiber.dispose()
 const results=[]
 for(const [kind,name,current,oldSpec]of cases){
  for(const stage of ['before','after']){
   for(const [reader,spec]of [['previous',oldSpec],['current',current]]){
    const ctx=new Context()
    const folder=join(root,`${kind}-${stage}-${reader}`)
    await mkdir(folder)
    const input=join(root,`${stage}-${kind}.json`)
    const target=join(folder,`${name}.json`)
    await copyFile(input,target)
    const before=digest(await readFile(target))
    let domain
    const result={kind,stage,reader,ok:false}
    try{
     await ctx.plugin(Storage)
     await ctx.plugin(StorageJson,{root:folder})
     await ctx.plugin(StorageDomain,{backend:'json'})
     domain=await ctx.storageDomain.open(spec)
     domain.global.get()
     result.ok=true
    }catch(error){result.code=error?.code}
    finally{await domain?.close();await ctx.fiber.dispose()}
    result.unchanged=before===digest(await readFile(target))
    results.push(result)
   }
  }
 }
 const ok=results.every(result=>result.unchanged&&(result.kind==='uploads'&&result.stage==='after'&&result.reader==='previous'
  ? !result.ok&&result.code==='invalid-record':result.ok))
 const report={ok,frozenSha256,authenticatedRequests:true,privateHistoryDenied:true,claimedActorRejected:true,
  originalBytesRetained:true,restorationRetainsVersions:true,results}
 const artifacts=join(repo,'.artifacts/enterprise-office')
 await mkdir(artifacts,{recursive:true})
 await writeFile(join(artifacts,'round122-reader-comparison.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
 assert.equal(ok,true)
}finally{
 await live.fiber.dispose()
 const absolute=resolve(root)
 if(!absolute.startsWith(resolve(tmpdir())+sep)||!basename(absolute).startsWith('dsh-office-drive-readers-'))
  throw new Error('Unexpected drive reader fixture directory')
 await rm(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
