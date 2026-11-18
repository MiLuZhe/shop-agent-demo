export type PlatformRole = 'user' | 'admin';
export type ShopRole = 'owner' | 'manager' | 'staff';
export type ShopPermission = 'catalog:read' | 'catalog:write' | 'orders:read' | 'orders:ship' | 'members:manage';
const shopPermissions: Record<ShopRole, readonly ShopPermission[]> = {
  owner: ['catalog:read','catalog:write','orders:read','orders:ship','members:manage'],
  manager: ['catalog:read','catalog:write','orders:read','orders:ship'],
  staff: ['catalog:read','orders:read','orders:ship'],
};
export function hasShopPermission(role: string, permission: ShopPermission): boolean {
  return Object.hasOwn(shopPermissions,role) && shopPermissions[role as ShopRole].includes(permission);
}
