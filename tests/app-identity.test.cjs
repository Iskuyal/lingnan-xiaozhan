const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('正式名称同步到默认与首页导航，开发者工具项目标识保持可用',()=>{
 const app=JSON.parse(fs.readFileSync('miniprogram/app.json','utf8'));
 const home=JSON.parse(fs.readFileSync('miniprogram/pages/home/index.json','utf8'));
 const project=JSON.parse(fs.readFileSync('project.config.json','utf8'));
 assert.equal(app.window.navigationBarTitleText,'课表小栈');
 assert.equal(home.navigationBarTitleText,'课表小栈');
 assert.equal(project.projectname,'wx-match');
 assert.match(project.description,/课表小栈/u);
});
