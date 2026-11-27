import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backendDirectory=fileURLToPath(new URL("..",import.meta.url));
const childEnvironment=()=>{
  const env={};
  for(const name of ["PATH","SystemRoot","SYSTEMROOT","WINDIR","TEMP","TMP"])if(process.env[name])env[name]=process.env[name];
  return env;
};
const runGuard=(script)=>{
  const result=spawnSync(process.execPath,[script],{cwd:backendDirectory,env:childEnvironment(),encoding:"utf8",timeout:5_000});
  assert.equal(result.error,undefined);
  assert.notEqual(result.status,0);
  return result.stderr;
};

test("mock load runner fails closed until explicit mock confirmation",()=>{
  assert.match(runGuard("scripts/load.mjs"),/AEGIS_LOAD_CONFIRM_MOCK/);
});
test("live provider runner fails closed until explicit confirmation",()=>{
  assert.match(runGuard("scripts/live-provider-compat.mjs"),/AEGIS_LIVE_PROVIDER_TEST_CONFIRM/);
});