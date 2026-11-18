import { useEffect, useRef, useState } from 'react';
import { MAX_PRODUCT_IMAGES, sumCartMoney, type ProductDto } from '@shop/contracts';
import { api } from '../api.ts';
import { useAuth } from '../auth/context.ts';
import { AddToCart } from '../cart/cart.tsx';
import { CheckoutForm } from '../orders/orders.tsx';
import { useChatLauncher } from '../chat/widget.tsx';
import { ProductArt } from './art.tsx';
import './styles.css';

function ProductGallery({ product }: { product: ProductDto }) {
  const images = product.imageUrls.slice(0, MAX_PRODUCT_IMAGES);
  const illustrative = images.some((url) => url.startsWith('/demo-media/'));
  const [index, setIndex] = useState(0), [failed, setFailed] = useState<string[]>([]);
  const startX = useRef<number | undefined>(undefined);
  const select = (value: number) => setIndex((value + images.length) % images.length);
  return <section className="product-gallery" aria-label="商品图片" tabIndex={0}
    onPointerDownCapture={(event) => { startX.current = event.clientX; }}
    onPointerUp={(event) => { if (startX.current !== undefined && Math.abs(event.clientX - startX.current) > 45 && images.length > 1) select(index + (event.clientX < startX.current ? 1 : -1)); startX.current = undefined; }}
    onKeyDown={(event) => { if (images.length > 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); select(index + (event.key === 'ArrowRight' ? 1 : -1)); } }}>
    <div className="gallery-media"><div className="gallery-stage">
      {images.length && !failed.includes(images[index]!) ? <img src={images[index]} alt={`${product.name} · 第 ${index + 1} 张展示图`} decoding="async" fetchPriority="high" draggable={false} onError={() => setFailed((items) => [...items, images[index]!])}/> : <div className="gallery-placeholder"><ProductArt product={{ ...product, imageUrls: [] }}/><p>{images.length ? '图片加载失败，可切换其他图片' : '商家暂未提供实拍图'}</p></div>}
      {images.length > 1 && <><button className="gallery-prev" aria-label="上一张图片" onClick={() => select(index - 1)}>‹</button><button className="gallery-next" aria-label="下一张图片" onClick={() => select(index + 1)}>›</button></>}
      {!!images.length && <span className="gallery-counter">{illustrative && '示意图 · '}<span aria-label="图片序号">{index + 1} / {images.length}</span></span>}
    </div>
    {images.length > 1 && <><div className="gallery-thumbnails" aria-label="选择展示图片">{images.map((url, position) => <button key={`${url}-${position}`} aria-label={`查看第 ${position + 1} 张图片`} aria-pressed={position === index} onClick={() => select(position)}>
      <img src={url} alt="" loading="lazy" decoding="async" onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }}/>
    </button>)}</div></>}</div>
  </section>;
}

function useProduct(id: string) {
  const [product, setProduct] = useState<ProductDto>(), [error, setError] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void api<ProductDto>(`/products/${encodeURIComponent(id)}`, { signal: controller.signal }).then(setProduct).catch((error: Error) => { if (error.name !== 'AbortError') setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, revision]);
  return { product, error, loading, retry: () => setRevision((value) => value + 1) };
}
function ProductState({ error, retry }: { error: string; retry: () => void }) {
  return error ? <section className="access-state" role="alert"><h1>暂时无法展示商品</h1><p>{error}</p><button className="primary-action" onClick={retry}>重新加载商品</button><a className="text-action" href="#catalog">返回商店</a></section> : <p role="status">正在读取商品…</p>;
}
export function ProductPage({ id }: { id: string }) {
  const { product, error, retry } = useProduct(id);
  const { user, pending } = useAuth();
  const { openChat, setPageContext } = useChatLauncher();
  const [skuId, setSkuId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('sku') ?? '');
  const sku = product?.skus.find((item) => item.id === skuId) ?? product?.skus.find((item) => item.stockQuantity > 0) ?? product?.skus[0];
  useEffect(() => {
    if (!product) return;
    setPageContext({ shopId: product.shopId, product: { id: product.id, name: product.name, imageUrl: product.imageUrls[0] ?? null, skuId: sku?.id ?? null, skuName: sku?.name ?? null } });
    return () => setPageContext(undefined);
  }, [product, sku?.id, sku?.name, setPageContext]);
  useEffect(() => { window.scrollTo(0, 0); }, [id]);
  return <main className="workspace product-page"><nav className="product-breadcrumb" aria-label="商品位置"><a className="action-link" href="#catalog">返回商店</a><span>/</span><span>商品详情</span></nav>
    {!product ? <ProductState error={error} retry={retry}/> : <>
      <div className="product-detail-layout"><ProductGallery key={product.id} product={product}/><section className="product-purchase" aria-label="商品详情">
        {!pending && (!user || user.canShop) && <button type="button" className="product-contact-link" onClick={() => openChat({ shopId: product.shopId, product: { id: product.id, name: product.name, imageUrl: product.imageUrls[0] ?? null, skuId: sku?.id ?? null, skuName: sku?.name ?? null } })}>咨询这件商品 ↗</button>}
        <span className="eyebrow">{product.shopName} · {product.category?.name ?? '日常发现'}</span><h1>{product.name}</h1><p className="product-intro">{product.description ?? '商品介绍待补充'}</p>
        <div className="pills">{product.tags.map((tag) => <span key={tag.id}>{tag.name}</span>)}</div>
        <div className="product-price"><span>当前规格单价</span><strong>¥{sku?.price ?? '—'}</strong></div>
        <fieldset className="product-specs"><legend>选择规格</legend><div role="radiogroup" aria-label="商品规格">{product.skus.map((item) => <button key={item.id} type="button" role="radio" aria-checked={sku?.id === item.id} onClick={() => setSkuId(item.id)}><strong>{item.name}</strong><span>¥{item.price}{!item.stockQuantity && ' · 暂时缺货'}</span></button>)}</div></fieldset>
        {sku && <><p className={sku.stockQuantity ? 'stock' : 'muted'}>{sku.stockQuantity ? `有货 · 剩余 ${sku.stockQuantity} 件` : '当前规格暂时缺货'}</p><AddToCart key={sku.id} sku={sku} productId={product.id}/>
          {!!sku.attributeCount && <details className="product-facts-wrap"><summary>规格参数 · {sku.attributeCount} 项</summary><dl className="product-facts">{sku.attributes.map((attribute) => <div key={attribute.id}><dt>{attribute.name}</dt><dd>{typeof attribute.value === 'boolean' ? attribute.value ? '是' : '否' : attribute.value}{attribute.unit ?? ''}</dd></div>)}</dl>
          {sku.attributeCount > sku.attributes.length && <p className="muted">展示前 20 项属性，更多资料可向店铺咨询。</p>}</details>}</>}
        {product.skuCount > product.skus.length && <p className="muted">共 {product.skuCount} 种规格，当前展示前 20 种。</p>}
      </section></div>
    </>}
  </main>;
}

export function DirectCheckoutPage({ id }: { id: string }) {
  const { product, error, retry, loading } = useProduct(id), { user, pending } = useAuth();
  const [locked, setLocked] = useState(false);
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const quantity = Number(params.get('quantity')), sku = product?.skus.find((item) => item.id === params.get('sku'));
  const valid = sku && Number.isInteger(quantity) && quantity >= 1 && quantity <= Math.min(999, sku.stockQuantity);
  return <main className="workspace direct-checkout-page"><div className="workspace-heading"><h1>确认结账</h1></div>
    <a className="text-action" href={`#/products/${id}`}>返回商品详情</a>
    {error && product && <p className="auth-error" role="alert">{error}</p>}
    {pending ? <p role="status">正在确认登录状态…</p> : !user ? <section className="access-state"><p>请登录后结账</p><a className="action-link" href="#/login">前往登录</a></section> : !product ? <ProductState error={error} retry={retry}/> : !valid ? <section className="access-state" role="alert"><p>规格不存在、已缺货或数量不符合当前库存，请返回商品页重新选择。</p></section> : <section className="cart-preview" aria-label="立即结账清单"><h2>{product.name}</h2><p>{sku.name} × {quantity} · 店铺：{product.shopName}</p><p>当前单价 ¥{sku.price} · 合计 <strong>¥{sumCartMoney([{ price: sku.price, quantity }])}</strong></p>
      <CheckoutForm key={`${sku.id}-${quantity}`} direct={{ skuId: sku.id, quantity, unitPrice: sku.price }} onLock={setLocked} disabled={loading || !!error}/>
      {!locked && <button className="text-action" disabled={loading} onClick={retry}>{loading ? '正在核价…' : '重新核价'}</button>}
    </section>}
  </main>;
}
