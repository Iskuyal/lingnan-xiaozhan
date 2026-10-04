const test=require('node:test');
const assert=require('node:assert/strict');

test('升学端上验证：初始示例请求结束后才能提交评测题',async()=>{
  const {waitForInitialExample}=require('../scripts/lib/advancement-bootstrap.cjs');
  const phases=['loading','loading','ready'];let waits=0;
  const page={data:async()=>phases.shift(),waitFor:async()=>{waits++;}};
  assert.equal(await waitForInitialExample(page), 'ready');
  assert.equal(waits,2);
});

test('升学端上验证：初始示例一直在途时停止，不能继续烧评测额度',async()=>{
  const {waitForInitialExample}=require('../scripts/lib/advancement-bootstrap.cjs');
  const page={data:async()=>'loading',waitFor:async()=>{}};
  await assert.rejects(waitForInitialExample(page,300),/初始示例/);
});
