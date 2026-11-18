import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { createDatabase } from '@shop/database';
import { hashPassword } from '@shop/database/password';
import { hasShopPermission, type CartItemDto, type OrderDetailDto, type SellerProductDetailDto, type SessionDto } from '@shop/contracts';
import { buildApp } from './app.ts';
import { requireShop } from './shops/access.ts';
const db = createDatabase(), app = buildApp(db,false,{loginLimit:200});
app.post('/test/member-management',{preHandler:requireShop(db,'members:manage')},async()=>({ok:true}));
const prefix=`identity_${randomUUID().slice(0,8)}`, users=Array.from({length:6},()=>randomUUID()), shops=[randomUUID(),randomUUID()], products=[randomUUID(),randomUUID()], skus=[randomUUID(),randomUUID()];
const cookies:string[]=[];
async function login(index:number) {
 const response=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:`${prefix}_${index}`,password:'Identity123!'}});
 assert.equal(response.statusCode,200,response.body); cookies[index]=String(response.headers['set-cookie']).split(';')[0]!; return response;
}
async function req(method:'GET'|'POST'|'PUT'|'DELETE',path:string,body?:unknown,user=0,shop:string|undefined=shops[0],cookie=cookies[user]??'') {
 return app.inject({method,url:path.startsWith('/test/')?path:`/api${path}`,headers:{cookie,...(shop?{'x-shop-id':shop}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{payload:JSON.stringify(body)})});
}
async function clear() {
 const rows=await db.order.findMany({where:{buyer_id:{in:users}},select:{id:true}});
 await db.orderItem.deleteMany({where:{order_id:{in:rows.map((row)=>row.id)}}});await db.order.deleteMany({where:{buyer_id:{in:users}}});await db.cartItem.deleteMany({where:{user_id:{in:users}}});
}
async function purchase(user=0) {
 const added=await req('POST','/cart/items',{skuId:skus[0],quantity:1},user);assert.equal(added.statusCode,201,added.body);const item=added.json<CartItemDto>();
 const response=await req('POST','/orders',{checkoutKey:randomUUID(),items:[{cartItemId:item.id,quantity:1,unitPrice:item.price,version:item.version}],recipientName:'测试用户',recipientPhone:'13800000000',recipientAddress:'测试省测试市测试地址'},user);
 assert.equal(response.statusCode,201,response.body);return response.json<OrderDetailDto>();
}
before(async()=>{
 const password_hash=await hashPassword('Identity123!');
 await db.user.createMany({data:users.map((id,i)=>({id,username:`${prefix}_${i}`,display_name:'身份测试用户',password_hash,platform_role:i===4?'admin':'user'}))});
 for(let i=0;i<shops.length;i++) {
  await db.shop.create({data:{id:shops[i],slug:`${prefix}_${i}`,name:`身份测试店${i}`}});
  await db.product.create({data:{id:products[i],shop_id:shops[i]!,name:`${prefix}_商品${i}`,status:'active',skus:{create:{id:skus[i],sku_code:`${prefix}_${i}`,name:'默认规格',price:'1.23',stock_quantity:10}}}});
 }
 await db.shopMember.createMany({data:[{shop_id:shops[0]!,user_id:users[1]!,role:'owner'},{shop_id:shops[0]!,user_id:users[2]!,role:'manager'},{shop_id:shops[0]!,user_id:users[3]!,role:'staff'},{shop_id:shops[1]!,user_id:users[5]!,role:'owner'}]});
});
beforeEach(async()=>{
 await clear();await db.shop.updateMany({where:{id:{in:shops}},data:{status:'active'}});await db.sku.updateMany({where:{id:{in:skus}},data:{stock_quantity:10}});
 await db.shopMember.updateMany({where:{shop_id:{in:shops}},data:{status:'active'}});
 for(let i=0;i<users.length;i++){await db.user.update({where:{id:users[i]},data:{platform_role:i===4?'admin':'user',status:'active'}});await login(i);}
});
after(async()=>{try{await clear();await db.sku.deleteMany({where:{product_id:{in:products}}});await db.product.deleteMany({where:{id:{in:products}}});await db.shopMember.deleteMany({where:{shop_id:{in:shops}}});await db.shop.deleteMany({where:{id:{in:shops}}});await db.user.deleteMany({where:{id:{in:users}}});}finally{await app.close();}});
test('customers can shop while all work roles and platform admins are isolated',async()=>{
 for(const index of [0,1,2,3,4,5]) {
  const identity=(await req('GET','/auth/me',undefined,index)).json<SessionDto>().user!;
  assert.equal(identity.canShop,index===0);assert.ok(!('role' in identity));
  for(const path of ['/orders','/cart','/account/addresses','/chat/channels']) assert.equal((await req('GET',path,undefined,index)).statusCode,index===0?200:403);
  assert.equal((await req('POST','/cart/items',{skuId:skus[1],quantity:1},index)).statusCode,index===0?201:403);
 }
 assert.equal((await req('GET','/seller/overview',undefined,1)).statusCode,200);
 const order=await purchase();assert.equal((await req('GET',`/orders/${order.id}`)).statusCode,200);
});
test('platform overview requires admin and exposes aggregate counts only',async()=>{
 assert.equal((await req('GET','/admin/overview',undefined,-1)).statusCode,401);
 for(const i of [0,1,2,3,5])assert.equal((await req('GET','/admin/overview',undefined,i)).statusCode,403);
 const response=await req('GET','/admin/overview',undefined,4);assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
 assert.deepEqual(Object.keys(response.json()).sort(),['activeShopCount','shopCount','userCount']);assert.ok(!response.body.includes('password'));assert.ok(!response.body.includes('recipient'));
});
test('admin cannot bypass store membership, inspect another buyers orders or ship for a shop',async()=>{
 const order=await purchase();
 for(const [method,path] of [['GET','/seller/overview'],['GET','/seller/products'],['GET','/seller/orders'],['GET',`/seller/orders/${order.id}`],['POST',`/seller/orders/${order.id}/ship`]]as const)assert.equal((await req(method,path,undefined,4)).statusCode,403);
 for(const [method,path]of[['GET',`/orders/${order.id}`],['POST',`/orders/${order.id}/mock-pay`],['POST',`/orders/${order.id}/cancel`]]as const)assert.equal((await req(method,path,undefined,4)).statusCode,403);
 assert.equal((await req('GET','/seller/shops',undefined,4)).json().items.length,0);
});
test('a user cannot forge platform or membership roles via login bodies, headers or absent mutation APIs',async()=>{
 for(const extra of [{role:'admin'},{platformRole:'admin'},{platform_role:'admin'},{canManageShops:true},{authVersion:999}])assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{username:`${prefix}_0`,password:'Identity123!',...extra}})).statusCode,400);
 const forged=await app.inject({url:'/api/admin/overview',headers:{cookie:cookies[0],'x-role':'admin','x-platform-role':'admin','x-user-id':users[4]}});assert.equal(forged.statusCode,403);
 assert.equal((await req('PUT','/account',{platformRole:'admin'})).statusCode,404);assert.equal((await req('POST','/admin/users',{username:'attack',platformRole:'admin'},4)).statusCode,404);
});
test('owner manager and staff capabilities fail closed for unknown roles',async()=>{
 assert.equal(hasShopPermission('owner','members:manage'),true);assert.equal(hasShopPermission('manager','members:manage'),false);assert.equal(hasShopPermission('staff','catalog:write'),false);
 for(const role of ['admin','sudo','root','__proto__','constructor','unknown'])assert.equal(hasShopPermission(role,'catalog:write'),false);
 for(const [i,expected]of[[1,200],[2,403],[3,403],[4,403]]as const)assert.equal((await req('POST','/test/member-management',undefined,i)).statusCode,expected);
});
test('staff can read products and fulfill orders but cannot change catalog price stock or metadata',async()=>{
 for(const path of ['/seller/products','/seller/categories','/seller/tags','/seller/attributes','/seller/overview','/seller/orders'])assert.equal((await req('GET',path,undefined,3)).statusCode,200);
 const detail=(await req('GET',`/seller/products/${products[0]}`,undefined,1)).json<SellerProductDetailDto>(),sku=detail.skus[0]!;
 const response=await req('PUT',`/seller/products/${products[0]}/skus/${sku.id}`,{skuCode:sku.skuCode,name:sku.name,price:'0.01',stockQuantity:999,isActive:true,attributes:[],version:sku.version},3);assert.equal(response.statusCode,403);
 assert.equal((await req('POST','/seller/categories',{name:'不允许',description:null,sortOrder:0,isActive:true},3)).statusCode,403);
 const order=await purchase();await req('POST',`/orders/${order.id}/mock-pay`);
 assert.equal((await req('POST',`/seller/orders/${order.id}/ship`,undefined,3)).statusCode,200);
});
test('managers can write their catalog but cannot administer members or access other shops',async()=>{
 const response=await req('POST','/seller/products',{name:`${prefix}_经理新建`,description:null,categoryId:null,tagIds:[],imageUrls:[],status:'draft',defaultSku:{skuCode:`${prefix}_manager`,name:'默认',price:'1.00',stockQuantity:1,isActive:true,attributes:[]}},2);assert.equal(response.statusCode,201,response.body);
 const id=response.json().id as string;try{assert.equal((await req('GET','/seller/products',undefined,2,shops[1])).statusCode,403);assert.equal((await req('POST','/test/member-management',undefined,2)).statusCode,403);}finally{await db.sku.deleteMany({where:{product_id:id}});await db.product.delete({where:{id}});}
});
test('quick promotion and demotion without an intervening request cannot revive old sessions',async()=>{
 const old=cookies[0]!;await db.user.update({where:{id:users[0]},data:{platform_role:'admin'}});await db.user.update({where:{id:users[0]},data:{platform_role:'user'}});
 assert.equal((await req('GET','/account',undefined,0,shops[0],old)).statusCode,401);await login(0);assert.equal((await req('GET','/admin/overview')).statusCode,403);
});
test('quick disable and re-enable without an intervening request invalidates old admin sessions',async()=>{
 const old=cookies[4]!;await db.user.update({where:{id:users[4]},data:{status:'disabled'}});await db.user.update({where:{id:users[4]},data:{status:'active'}});
 assert.equal((await req('GET','/admin/overview',undefined,4,shops[0],old)).statusCode,401);await login(4);assert.equal((await req('GET','/admin/overview',undefined,4)).statusCode,200);
});
test('database owns monotonic auth version; profile edits do not revoke login and sensitive changes do',async()=>{
 const before=await db.user.findUniqueOrThrow({where:{id:users[0]}});await db.user.update({where:{id:users[0]},data:{display_name:'修改显示名称'}});
 assert.equal((await db.user.findUniqueOrThrow({where:{id:users[0]}})).auth_version,before.auth_version);assert.equal((await req('GET','/account')).statusCode,200);
 await assert.rejects(db.user.update({where:{id:users[0]},data:{auth_version:1+before.auth_version}}),/maintained by the database/);
 await assert.rejects(db.user.update({where:{id:users[0]},data:{platform_role:'root'}}),/users_identity_check/);
 await db.user.update({where:{id:users[0]},data:{password_hash:await hashPassword('Identity123!')}});assert.equal((await req('GET','/account')).statusCode,401);
});
test('disabled or removed memberships never turn work accounts into buyers',async()=>{
 await db.shopMember.update({where:{shop_id_user_id:{shop_id:shops[0]!,user_id:users[1]!}},data:{status:'disabled'}});
 assert.equal((await req('GET','/seller/overview',undefined,1)).statusCode,403);
 assert.equal((await req('GET','/orders',undefined,1)).statusCode,403);
 const user=(await req('GET','/auth/me',undefined,1)).json<SessionDto>().user!;
 assert.equal(user.canManageShops,false);assert.equal(user.canShop,false);
 await assert.rejects(db.user.update({where:{id:users[1]},data:{account_kind:'customer'}}),/work account cannot become/);
});
test('platform demotion preserves membership after new login and disabled shops do not grant admin bypass',async()=>{
 await db.shopMember.create({data:{shop_id:shops[0]!,user_id:users[4]!,role:'staff'}});
 try{
  assert.equal((await req('GET','/seller/overview',undefined,4)).statusCode,200);await db.user.update({where:{id:users[4]},data:{platform_role:'user'}});assert.equal((await req('GET','/seller/overview',undefined,4)).statusCode,401);
  await login(4);assert.equal((await req('GET','/admin/overview',undefined,4)).statusCode,403);assert.equal((await req('GET','/seller/overview',undefined,4)).statusCode,200);
  await db.shop.update({where:{id:shops[0]},data:{status:'disabled'}});assert.equal((await req('GET','/seller/overview',undefined,4)).statusCode,403);
 }finally{await db.shopMember.deleteMany({where:{user_id:users[4]}});}
});
