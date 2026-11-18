import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { createDatabase } from '../../packages/database/src/index.ts';
import { hashPassword } from '../../packages/database/src/password.ts';
import { DEFAULT_SHOP_ID } from '../../packages/contracts/src/common.ts';
import { submitLogin, openAccount } from './login.ts';
const test=base.extend<{identity:{name:string;login:(index:number)=>Promise<void>}}>({
 identity:async({page},use)=>{
  const db=createDatabase(),prefix=`identity_ui_${randomUUID().slice(0,8)}`,users=[randomUUID(),randomUUID(),randomUUID()],productId=randomUUID();
  try{
   const password_hash=await hashPassword('IdentityUi123!');
   await db.user.createMany({data:users.map((id,i)=>({id,username:`${prefix}_${i}`,display_name:i===2?'测试平台管理员':i===1?'测试店员':'测试店长',platform_role:i===2?'admin':'user',password_hash}))});
   await db.shopMember.createMany({data:[{shop_id:DEFAULT_SHOP_ID,user_id:users[0]!,role:'owner'},{shop_id:DEFAULT_SHOP_ID,user_id:users[1]!,role:'staff'}]});
   await db.product.create({data:{id:productId,shop_id:DEFAULT_SHOP_ID,name:prefix,status:'active',skus:{create:{name:'身份验证规格',sku_code:prefix,price:'1.00',stock_quantity:10}}}});
   await use({name:prefix,login:async(index)=>{
    await page.goto('/#/login');await page.getByLabel('账号',{exact:true}).fill(`${prefix}_${index}`);await page.getByLabel('密码',{exact:true}).fill('IdentityUi123!');await submitLogin(page);
    await expect(page.getByRole('heading',{name:index===2?'我的账号':'卖家工作台',exact:true})).toBeVisible();
   }});
  }finally{
   await db.cartItem.deleteMany({where:{user_id:{in:users}}});await db.sku.deleteMany({where:{product_id:productId}});await db.product.deleteMany({where:{id:productId}});await db.shopMember.deleteMany({where:{user_id:{in:users}}});await db.user.deleteMany({where:{id:{in:users}}});await db.$disconnect();
  }
 }
});
test('work accounts keep shop access but cannot use personal shopping or buyer chat',async({page,identity},info)=>{
 for (const index of [0,1,2]) {
  await identity.login(index);
  for (const name of ['购物车','我的订单','消息']) await expect(page.locator('.store-nav').getByRole('link',{name,exact:true})).toHaveCount(0);
  await page.goto('/#catalog');await expect(page.locator('.results')).toHaveAttribute('aria-busy','false');
  await page.getByRole('textbox',{name:'顶部商品搜索',exact:true}).fill(identity.name);await page.locator('.header-search').getByRole('button',{name:'找商品',exact:true}).click();await expect(page.locator('.product-card')).toHaveCount(1);await page.locator('.product-card').click();
  await expect(page.getByRole('button',{name:'加入购物车',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'立即购买',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'咨询这件商品',exact:false})).toHaveCount(0);
  for(const route of ['cart','orders','messages','checkout/fake']) { await page.goto(`/#/${route}`);await expect(page.getByRole('heading',{name:'请使用买家账号',exact:true})).toBeVisible(); }
  for(const path of ['cart','orders','account/addresses','chat/channels']) expect((await page.request.get(`/api/${path}`)).status()).toBe(403);
  await openAccount(page);await expect(page.getByRole('button',{name:'添加常用地址',exact:true})).toHaveCount(0);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('work-account.png'),fullPage:true});
});
test('staff receives a clear catalog denial and admin has no implicit store authority',async({page,identity},info)=>{
 await identity.login(1);await page.getByRole('navigation',{name:'管理模块'}).getByRole('button',{name:'分类',exact:true}).click();await page.getByRole('button',{name:'新建分类',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill(`${identity.name}_禁止创建`);await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('alert')).toContainText('店内角色无权');
 await identity.login(2);await expect(page.locator('.account-card')).toContainText('平台管理员');await expect(page.locator('.store-nav').getByRole('link',{name:'卖家工作台',exact:true})).toHaveCount(0);
 expect((await page.request.get('/api/admin/overview')).status()).toBe(200);expect((await page.request.get('/api/seller/overview')).status()).toBe(403);await page.goto('/#/seller');await expect(page.getByRole('heading',{name:'此功能需要店铺授权',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:info.outputPath('admin-boundary.png'),fullPage:true});
});
