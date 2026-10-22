'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const path=require('node:path');
for(const required of [false,true])test('worker answers JSON-RPC when '+(required?'loaded by host bootstrap':'executed directly'),()=>{
 const entry=path.resolve(__dirname,'../node/worker.cjs');
 const args=required?['-e','require('+JSON.stringify(entry)+')']:[entry];
 const input=JSON.stringify({jsonrpc:'2.0',id:7,method:'unknown-test-method',params:{}})+'\n';
 const output=execFileSync(process.execPath,args,{input,encoding:'utf8',timeout:3000});
 const response=JSON.parse(output);assert.equal(response.id,7);assert.equal(response.jsonrpc,'2.0');assert(response.error);
});
