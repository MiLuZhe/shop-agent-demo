import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttributeDefinitionDto, AttributeFilter, CategoryDto, Page, ProductDto, TagDto } from '@shop/contracts';
import './styles.css';
import { api } from './api.ts';
import { StoreShell } from './auth/shell.tsx';
import { ProductArt } from './products/art.tsx';
import './actions.css';
import './theme.css';

function catalogQueryFromHash() { return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q') ?? ''; }
const validMoney = (value: string) => /^\d{1,10}(\.\d{1,2})?$/.test(value);
function App() {
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [definitions, setDefinitions] = useState<AttributeDefinitionDto[]>([]);
  const [bootstrapError, setBootstrapError] = useState('');
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState(catalogQueryFromHash);
  const [category, setCategory] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState('all');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [inStock, setInStock] = useState(false);
  const [attributeId, setAttributeId] = useState('');
  const [attributeValue, setAttributeValue] = useState('');
  const [attributeOp, setAttributeOp] = useState<'eq' | 'gte' | 'lte'>('lte');
  const [attributes, setAttributes] = useState<AttributeFilter[]>([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<ProductDto>>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('filters') === '1');
  const filterDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const open = () => setFiltersOpen(true);
    window.addEventListener('shop:open-filters', open);
    return () => window.removeEventListener('shop:open-filters', open);
  }, []);
  useEffect(() => {
    if (!filtersOpen) { filterDialog.current?.close(); return; }
    filterDialog.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [filtersOpen]);
  useEffect(() => {
    const sync = () => { if (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('filters') === '1') setFiltersOpen(true); const query = catalogQueryFromHash(); setSearch(query); setPage(1); };
    window.addEventListener('hashchange', sync);
    window.addEventListener('shop:catalog-search', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('shop:catalog-search', sync); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBootstrapError('');
    void Promise.all([
      api<{ items: CategoryDto[] }>('/categories?pageSize=50', { signal: controller.signal }),
      api<Page<TagDto>>('/tags?pageSize=50', { signal: controller.signal }),
      api<Page<AttributeDefinitionDto>>('/filters?pageSize=50', { signal: controller.signal }),
    ]).then(([c, t, f]) => { setCategories(c.items); setTags(t.items); setDefinitions(f.items); }).catch((e: Error) => {
      if (e.name !== 'AbortError') setBootstrapError(e.message);
    });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page), pageSize: '12', tagMode, inStock: String(inStock) });
    if (search) query.set('q', search);
    if (category) query.set('categoryId', category);
    if (tagIds.length) query.set('tagIds', tagIds.join(','));
    if (validMoney(minPrice)) query.set('minPrice', minPrice);
    if (validMoney(maxPrice)) query.set('maxPrice', maxPrice);
    if (attributes.length) query.set('attributes', JSON.stringify(attributes));
    setLoading(true); setError('');
    void api<Page<ProductDto>>(`/products?${query}`, { signal: controller.signal }).then(setData).catch((e: Error) => {
      if (e.name !== 'AbortError') { setError(e.message); setData(undefined); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, category, tagIds, tagMode, inStock, minPrice, maxPrice, attributes, page, reload]);
  const definition = definitions.find((d) => d.id === attributeId);
  const filterCount = Number(!!category) + tagIds.length + Number(!!minPrice) + Number(!!maxPrice) + Number(inStock) + attributes.length;
  function closeFilters() {
    setFiltersOpen(false);
    const [route, query] = window.location.hash.split('?');
    const params = new URLSearchParams(query);
    params.delete('filters');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${route}${params.size ? `?${params}` : ''}`);
  }
  function clearFilters() {
    setCategory(''); setTagIds([]); setTagMode('all'); setMinPrice(''); setMaxPrice(''); setInStock(false); setAttributes([]); setAttributeId(''); setAttributeValue(''); setAttributeOp('lte'); setPage(1);
  }
  function reset() {
    setSearch(''); clearFilters();
    if (window.location.hash.includes('?')) window.location.hash = window.location.hash.split('?')[0] || '#catalog';
    window.dispatchEvent(new Event('shop:catalog-search'));
  }
  function addAttribute() {
    if (!definition || attributeValue === '') return;
    const base = { attributeId: definition.id };
    const filter: AttributeFilter = definition.dataType === 'number'
      ? { ...base, type: 'number', op: attributeOp, value: attributeValue }
      : definition.dataType === 'boolean' ? { ...base, type: 'boolean', op: 'eq', value: attributeValue === 'true' }
      : { ...base, type: 'text', op: 'eq', value: attributeValue };
    setAttributes((values) => [...values.filter((a) => a.attributeId !== definition.id || a.op !== filter.op), filter].slice(-10));
    setAttributeValue(''); setPage(1);
  }
  return <>
    <main>
      <section className="hero"><div><h1>商店。<span>好选择，就在这里。</span></h1><p>从数码配件到日常用品，找到适合你的那一件。</p></div>
        <a className="hero-link" href="#catalog">浏览全部商品 <span aria-hidden="true">↗</span></a>
      </section>
      <section id="catalog" className="catalog"><div className="catalog-title"><div><h2>发现你的日常好物</h2></div></div>
        <div className="catalog-layout catalog-layout-full"><div className="results" aria-busy={loading}><div className="results-bar"><span>{loading ? '正在寻找好物…' : `找到 ${data?.total ?? 0} 件好物`}</span>{filterCount > 0 && <span>已启用 {filterCount} 项筛选</span>}</div>
          {error ? <div className="empty" role="alert"><h3>暂时无法展示商品</h3><p>{error}</p><button onClick={() => setReload((v) => v + 1)}>重新加载</button></div>
            : loading ? <div className="grid">{[1, 2, 3].map((n) => <div className="skeleton" key={n} />)}</div>
            : !data?.items.length ? <div className="empty"><h3>还没有找到合适的商品</h3><p>试试减少一些条件，或换一个关键词。</p><button onClick={reset}>清除筛选</button></div>
            : <div className="grid">{data.items.map((product, index) => <a className="product-card" key={product.id} href={`#/products/${product.id}`} aria-label={`查看${product.name}`}>
              <div className="card-copy"><span className="card-category">{product.category?.name ?? '精选商品'}</span><h3>{product.name}</h3><p className="card-description">{product.description ?? '查看商品规格与详细信息'}</p></div>
              <ProductArt product={product} priority={index === 0}/>
              <div className="card-footer"><div className="pills">{product.tags.slice(0, 3).map((t) => <span key={t.id}>{t.name}</span>)}</div><div className="card-bottom"><strong>¥{product.skus.reduce((min, s) => Number(s.price) < Number(min) ? s.price : min, product.skus[0]?.price ?? '0.00')}<small>{product.skus.length > 1 ? ' 起' : ''}</small></strong><span>{product.skus.some((s) => s.stockQuantity > 0) ? '查看商品 ↗' : '暂时缺货'}</span></div></div>
            </a>)}</div>}
          {data && data.total > 12 && !loading && <nav className="pagination" aria-label="商品分页"><button disabled={page === 1} onClick={() => setPage((v) => v - 1)}>上一页</button><span>{page} / {Math.ceil(data.total / 12)}</span><button disabled={page * 12 >= data.total} onClick={() => setPage((v) => v + 1)}>下一页</button></nav>}
        </div></div>
      </section>
    </main><footer><a className="brand" href="/">拾物<span className="brand-sub">SHIWU</span></a><span>把日常，过成喜欢的样子。</span><small>课程演示商店</small></footer>
    <dialog id="product-filters" className="filter-dialog" ref={filterDialog} aria-labelledby="filter-title" onCancel={closeFilters} onClick={(event) => { if (event.target === filterDialog.current) closeFilters(); }}>
      <div className="filter-dialog-heading"><div><h2 id="filter-title">筛选商品</h2></div><button className="close" onClick={closeFilters} aria-label="关闭筛选">×</button></div>
      <div className="filter-dialog-body">{bootstrapError && <div className="error" role="alert">筛选项暂时无法加载：{bootstrapError} <button onClick={() => setReload((v) => v + 1)}>重试</button></div>}<fieldset className="filter-categories"><legend>商品分类</legend>
        <div className="category-tabs" aria-label="商品分类"><button aria-pressed={!category} className={!category ? 'selected' : ''} onClick={() => { setCategory(''); setPage(1); }}>全部好物</button>{categories.map((c) => <button key={c.id} aria-pressed={category === c.id} className={category === c.id ? 'selected' : ''} onClick={() => { setCategory(c.id); setPage(1); }}>{c.name}</button>)}</div>
      </fieldset><div className="filter-fields">

          <fieldset><legend>生活场景与用途</legend><div className="tag-buttons">{tags.map((tag) => <button key={tag.id} aria-pressed={tagIds.includes(tag.id)} className={tagIds.includes(tag.id) ? 'selected' : ''} onClick={() => { setTagIds((ids) => ids.includes(tag.id) ? ids.filter((id) => id !== tag.id) : [...ids, tag.id]); setPage(1); }}>{tag.name}</button>)}</div>
            <label className="select-label">多个标签<select value={tagMode} onChange={(e) => { setTagMode(e.target.value); setPage(1); }}><option value="all">全部满足</option><option value="any">任一满足</option></select></label></fieldset>
          <fieldset><legend>预算区间</legend><div className="price-inputs"><span className="price-field"><input aria-label="最低价格" placeholder="最低 ¥" type="number" min="0" max="9999999999.99" step="0.01" value={minPrice} onBlur={(e) => { if (e.currentTarget.value) e.currentTarget.reportValidity(); }} onChange={(e) => { setMinPrice(e.target.value); setPage(1); }}/></span><span>—</span><span className="price-field"><input aria-label="最高价格" placeholder="最高 ¥" type="number" min="0" max="9999999999.99" step="0.01" value={maxPrice} onBlur={(e) => { if (e.currentTarget.value) e.currentTarget.reportValidity(); }} onChange={(e) => { setMaxPrice(e.target.value); setPage(1); }}/></span></div><label className="check"><input type="checkbox" checked={inStock} onChange={(e) => { setInStock(e.target.checked); setPage(1); }}/>只看有货商品</label></fieldset>
          <fieldset><legend>规格偏好</legend><select aria-label="筛选属性" value={attributeId} onChange={(e) => { setAttributeId(e.target.value); setAttributeValue(''); }}><option value="">选择商品属性</option>{definitions.map((d) => <option key={d.id} value={d.id}>{d.name}{d.unit ? `（${d.unit}）` : ''}</option>)}</select>
            {definition && <form className="attribute-form" onSubmit={(e) => { e.preventDefault(); addAttribute(); }}>
              {definition.dataType === 'number' && <select aria-label="数值比较" value={attributeOp} onChange={(e) => setAttributeOp(e.target.value as typeof attributeOp)}><option value="lte">不高于</option><option value="gte">不低于</option><option value="eq">等于</option></select>}
              {definition.dataType === 'enum' ? <select aria-label="属性取值" required value={attributeValue} onChange={(e) => setAttributeValue(e.target.value)}><option value="">选择{definition.name}</option>{definition.options?.map((o) => <option key={o}>{o}</option>)}</select>
                : definition.dataType === 'boolean' ? <select aria-label="属性取值" required value={attributeValue} onChange={(e) => setAttributeValue(e.target.value)}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
                : <input aria-label="属性取值" required type="text" inputMode={definition.dataType === 'number' ? 'decimal' : 'text'} pattern={definition.dataType === 'number' ? '-?[0-9]{1,14}(\\.[0-9]{1,4})?' : undefined} title={definition.dataType === 'number' ? '请输入最多 14 位整数、4 位小数的数值' : undefined} maxLength={255} value={attributeValue} onChange={(e) => setAttributeValue(e.target.value)} placeholder={definition.unit ?? '填写属性值'}/>}
              <button className="apply">添加条件</button>
            </form>}
            <div className="conditions">{attributes.map((a, i) => <button key={`${a.attributeId}-${a.op}`} onClick={() => { setAttributes((v) => v.filter((_, n) => n !== i)); setPage(1); }} aria-label={`删除筛选条件 ${definitions.find((d) => d.id === a.attributeId)?.name}`}>
              {definitions.find((d) => d.id === a.attributeId)?.name} {a.op === 'gte' ? '≥' : a.op === 'lte' ? '≤' : '='} {String(a.value === true ? '是' : a.value === false ? '否' : a.value)} ×</button>)}</div>
          </fieldset>

              </div></div>
      <div className="filter-dialog-actions"><button className="filter-reset" onClick={clearFilters}>重置</button><span role="status">{loading ? '正在寻找…' : `找到 ${data?.total ?? 0} 件好物`}</span><button className="primary-action" onClick={closeFilters}>查看结果</button></div>
    </dialog>
  </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><StoreShell><App /></StoreShell></StrictMode>);
