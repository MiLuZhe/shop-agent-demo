import { useState } from 'react';
import type { ProductDto } from '@shop/contracts';

export function Glyph({ kind }: { kind: string }) {
  const paths: Record<string, React.ReactNode> = {
    mouse: <><rect x="33" y="15" width="54" height="88" rx="27"/><path d="M60 15v32M34 49h52"/><rect x="57" y="29" width="6" height="13" rx="3"/></>,
    cup: <><rect x="38" y="27" width="45" height="72" rx="12"/><path d="M42 26v-9h37v9M46 60h29M47 17v-4h27v4"/></>,
    book: <><rect x="28" y="22" width="65" height="79" rx="5"/><path d="M40 22v79M53 47h26M53 58h20M26 39h7M26 55h7M26 71h7M26 87h7"/></>,
    bag: <><path d="M24 45h72l-5 51H29zM41 44V32a19 19 0 0 1 38 0v12M36 59h48M60 60v12"/></>,
    charger: <><rect x="29" y="37" width="64" height="59" rx="13"/><path d="M44 37V22M58 37V22M46 66h28M50 73h20"/></>,
  };
  return <svg viewBox="0 0 120 120" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">{paths[kind] ?? paths.bag}</svg>;
}
const productKind = (p: ProductDto) => p.name.includes('鼠标') ? 'mouse' : p.name.includes('杯') ? 'cup' : p.name.includes('本') ? 'book' : p.name.includes('充电') ? 'charger' : 'bag';
export function ProductArt({ product, priority = false }: { product: ProductDto; priority?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <div className={`product-art ${productKind(product)}`}>
    {product.imageUrls[0] && !failed ? <img src={product.imageUrls[0]} alt={product.name} loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} decoding="async" onError={() => setFailed(true)} /> : <Glyph kind={productKind(product)} />}
  </div>;
}
