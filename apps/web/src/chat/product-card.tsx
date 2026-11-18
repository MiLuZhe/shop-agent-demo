import { useState, type MouseEvent } from 'react';
import type { ChatProductDto, AgentCardDto } from '@shop/contracts';

// Preserve native open-in-new-tab behavior while revealing the destination beneath the widget.
function openProduct(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    window.dispatchEvent(new Event('shop:chat-product-opened'));
  }
}

export function AgentRecommendation({ card }: { card: AgentCardDto }) {
  const [failed, setFailed] = useState(false);
  return <a className="chat-product-card agent-recommendation" href={`#/products/${card.productId}?sku=${encodeURIComponent(card.skuId)}`} onClick={openProduct} aria-label={`查看推荐商品：${card.name}`}>
    <span className="recommendation-media">{card.imageUrl && !failed ? <img src={card.imageUrl} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}/> : <span className="chat-product-placeholder" aria-hidden="true">物</span>}</span>
    <span className="recommendation-info"><strong>{card.name}</strong><span className="recommendation-sku">{card.skuName}</span>{card.reason && <span className="recommendation-reason">{card.reason}</span>}<span className="recommendation-footer"><b className="recommendation-price">¥{card.price}</b><span className="recommendation-action">查看商品 <span aria-hidden="true">↗</span></span></span></span>
  </a>;
}

export function ChatProductCard({ product }: { product: ChatProductDto }) {
  const [failed, setFailed] = useState(false);
  return <a className="chat-product-card" href={`#/products/${product.id}${product.skuId ? `?sku=${encodeURIComponent(product.skuId)}` : ''}`} onClick={openProduct} aria-label={`查看咨询商品：${product.name}`}>
    {product.imageUrl && !failed ? <img src={product.imageUrl} alt="" onError={() => setFailed(true)}/> : <span className="chat-product-placeholder" aria-hidden="true">物</span>}
    <span><small>咨询商品</small><strong>{product.name}</strong>{product.skuName && <span>规格：{product.skuName}</span>}</span><span aria-hidden="true">↗</span>
  </a>;
}
