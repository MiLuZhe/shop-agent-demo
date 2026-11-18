import { createDatabase } from '../src/index.ts';
import { DEFAULT_SHOP_ID } from '../../contracts/src/common.ts';
import { hashPassword } from '../src/password.ts';
import { demoProductImages } from './demo-images.ts';

const db = createDatabase();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Stable IDs and empty updates make reruns additive: never reset edited prices or stock.
try {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed is for local development only');
  const demoPasswords = {
    buyer_demo: await hashPassword(process.env.DEMO_BUYER_PASSWORD ?? 'BuyerDemo123!'),
    seller_demo: await hashPassword(process.env.DEMO_SELLER_PASSWORD ?? 'SellerDemo123!'),
    manager_demo: await hashPassword(process.env.DEMO_MANAGER_PASSWORD ?? 'ManagerDemo123!'),
    staff_demo: await hashPassword(process.env.DEMO_STAFF_PASSWORD ?? 'StaffDemo123!'),
  };
  await db.$transaction(async (tx) => {
    await tx.shop.upsert({ where: { id: DEFAULT_SHOP_ID }, update: {}, create: { id: DEFAULT_SHOP_ID, slug: 'shiwu', name: '拾物' } });
    for (const [n, username, display_name, shopRole] of [
      [1, 'buyer_demo', '演示买家', null],
      [2, 'seller_demo', '演示店长', 'owner'],
      [4, 'manager_demo', '演示经理', 'manager'],
      [5, 'staff_demo', '演示店员', 'staff'],
    ] as const) {
      const user = await tx.user.upsert({ where: { id: id(n) }, update: {}, create: {
        id: id(n), username, display_name, password_hash: demoPasswords[username],
      } });
      if (shopRole) await tx.shopMember.upsert({ where: { shop_id_user_id: { shop_id: DEFAULT_SHOP_ID, user_id: user.id } }, update: {}, create: { shop_id: DEFAULT_SHOP_ID, user_id: user.id, role: shopRole } });
      // Upgrade pre-auth demo identities without resetting an existing password.
      await tx.user.updateMany({ where: { id: user.id, password_hash: null }, data: { password_hash: demoPasswords[username] } });
    }
    for (const [n, name] of [[10, '数码配件'], [11, '生活用品'], [12, '文具']] as const) {
      await tx.category.upsert({ where: { id: id(n) }, update: {}, create: { shop_id: DEFAULT_SHOP_ID, id: id(n), name, sort_order: n } });
    }
    for (const [n, name, group_name, is_active] of [
      [20, '通勤', '场景', true], [21, '旅行', '场景', true], [22, '桌面', '场景', true],
      [23, '送礼', '用途', true], [24, '旧标签', '演示停用', false],
    ] as const) {
      await tx.tag.upsert({ where: { id: id(n) }, update: {}, create: { shop_id: DEFAULT_SHOP_ID, id: id(n), name, group_name, is_active, sort_order: n } });
    }
    const definitions = [
      { id: id(30), code: 'weight_g', name: '重量', data_type: 'number', unit: 'g' },
      { id: id(31), code: 'waterproof', name: '防水', data_type: 'boolean' },
      { id: id(32), code: 'color', name: '颜色', data_type: 'enum', options: ['黑色', '白色', '绿色'] },
      { id: id(33), code: 'capacity_ml', name: '容量', data_type: 'number', unit: 'ml' },
    ];
    for (const definition of definitions) {
      await tx.attributeDefinition.upsert({ where: { shop_id_code: { shop_id: DEFAULT_SHOP_ID, code: definition.code } }, update: {}, create: { ...definition, shop_id: DEFAULT_SHOP_ID } });
    }
    const products = [
      { n: 100, name: '轻行无线鼠标', category: 10, description: '安静按键，适合办公和随身携带。', tags: [20, 22], status: 'active' },
      { n: 101, name: '随行保温杯', category: 11, description: '双层杯身，适合日常通勤。', tags: [20, 21, 23], status: 'active' },
      { n: 102, name: '留白笔记本', category: 12, description: '平摊书写，记录灵感。', tags: [22, 23], status: 'active' },
      { n: 103, name: '轻旅收纳包', category: null, description: '不限定类别的跨场景收纳用品。', tags: [20, 21, 24], status: 'active' },
      { n: 104, name: '折叠充电器', category: 10, description: '折叠插脚，适合旅行。', tags: [21, 22], status: 'active' },
      { n: 105, name: '尚未发布的样品', category: null, description: '用于验证草稿不会出现在公共搜索。', tags: [], status: 'draft' },
      { n: 106, name: '磁吸折叠手机支架', category: 10, description: '角度可调的轻便支架，适合桌面视频和通勤收纳。', tags: [20, 22], status: 'active' },
      { n: 107, name: '随行咖啡保温杯', category: 11, description: '轻巧杯身搭配密封杯盖，方便带去办公室或旅途中。', tags: [20, 21, 23], status: 'active' },
      { n: 108, name: '旅行分装收纳盒', category: null, description: '小件物品分类收纳，可放入行李包或办公抽屉。', tags: [21, 23], status: 'active' },
      { n: 109, name: '点阵便携笔记本', category: 12, description: 'A5 尺寸点阵内页，适合随手记录和简单规划。', tags: [22, 23], status: 'active' },
    ];
    for (const product of products) {
      await tx.product.upsert({ where: { id: id(product.n) }, update: {}, create: {
        shop_id: DEFAULT_SHOP_ID, id: id(product.n), name: product.name, description: product.description, status: product.status,
        image_urls: demoProductImages.find((entry) => entry.id === id(product.n))?.imageUrls ?? [],
        category_id: product.category === null ? null : id(product.category),
      } });
      for (const tag of product.tags) {
        await tx.productTag.upsert({ where: { product_id_tag_id: { product_id: id(product.n), tag_id: id(tag) } }, update: {},
          create: { product_id: id(product.n), tag_id: id(tag) } });
      }
    }
    const skus = [
      { n: 200, product: 100, name: '标准黑色版', price: '79.00', stock: 20, weight: '110', color: '黑色' },
      { n: 201, product: 100, name: '轻量白色版', price: '129.00', stock: 12, weight: '65', color: '白色' },
      { n: 202, product: 101, name: '绿色 350ml', price: '89.90', stock: 30, weight: '230', color: '绿色', capacity: '350', waterproof: true },
      { n: 203, product: 101, name: '黑色 500ml', price: '109.90', stock: 0, weight: '300', color: '黑色', capacity: '500', waterproof: true },
      { n: 204, product: 102, name: '默认规格', price: '29.90', stock: 50, weight: '180' },
      { n: 205, product: 103, name: '绿色', price: '39.00', stock: 15, weight: '75', color: '绿色', waterproof: false },
      { n: 206, product: 104, name: '白色 65W', price: '159.00', stock: 8, weight: '120', color: '白色' },
      { n: 207, product: 105, name: '样品', price: '1.00', stock: 10, weight: '1' },
      { n: 208, product: 100, name: '已禁用规格', price: '1.00', stock: 5, weight: '1', disabled: true },
      { n: 209, product: 106, name: '黑色可调款', price: '35.00', stock: 24, weight: '92', color: '黑色' },
      { n: 210, product: 107, name: '米白 420ml', price: '69.00', stock: 18, weight: '240', color: '白色', capacity: '420', waterproof: true },
      { n: 211, product: 108, name: '薄荷绿组合', price: '25.50', stock: 30, weight: '130', color: '绿色', waterproof: false },
      { n: 212, product: 109, name: 'A5 点阵内页', price: '16.90', stock: 40, weight: '120' },
    ];
    for (const sku of skus) {
      await tx.sku.upsert({ where: { id: id(sku.n) }, update: {}, create: {
        id: id(sku.n), product_id: id(sku.product), sku_code: `DEMO-${sku.n}`, name: sku.name,
        price: sku.price, stock_quantity: sku.stock, is_active: !('disabled' in sku && sku.disabled),
      } });
      const values = [
        { definition: 30, number_value: sku.weight },
        ...('color' in sku ? [{ definition: 32, text_value: sku.color }] : []),
        ...('capacity' in sku ? [{ definition: 33, number_value: sku.capacity }] : []),
        ...('waterproof' in sku ? [{ definition: 31, boolean_value: sku.waterproof }] : []),
      ];
      for (const { definition, ...value } of values) {
        const key = { sku_id: id(sku.n), attribute_definition_id: id(definition) };
        await tx.skuAttributeValue.upsert({ where: { sku_id_attribute_definition_id: key }, update: {}, create: { ...key, ...value } });
      }
    }
  });
  console.log('Seed ready: 1 default shop with owner/manager/staff, 4 demo identities, 3 categories, 5 tags, 4 attributes, 10 products, 13 SKUs. Existing records preserved.');
} finally {
  await db.$disconnect();
}
