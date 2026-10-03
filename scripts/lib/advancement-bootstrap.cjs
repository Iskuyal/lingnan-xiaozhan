/** 页面onLoad会发出示例请求；验证题必须在它结束后提交，避免争抢月度记账闸门。 */
async function waitForInitialExample(page,timeoutMs=60000){
  const polls=Math.ceil(timeoutMs/300);
  for(let i=0;i<polls;i++){
    const phase=await page.data('modelPhase');
    if(phase!=='loading')return phase;
    await page.waitFor(300);
  }
  throw new Error('初始示例仍在请求中，停止本轮，不发送验证题');
}
module.exports={waitForInitialExample};
