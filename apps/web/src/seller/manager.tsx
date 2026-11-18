import { Fragment, cloneElement, useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import type { Page, SellerCategoryDto, SellerTagDto, SellerDefinitionDto, SellerProductDto, SellerProductDetailDto, SkuWrite, ProductWrite } from '@shop/contracts';
import { api } from '../api.ts';
import { MAX_PRODUCT_IMAGES } from '@shop/contracts';
import { ManageDialog } from './dialog.tsx';
import './styles.css';

type Tab = 'products' | 'categories' | 'tags' | 'attributes';
type Lookup = SellerCategoryDto | SellerTagDto | SellerDefinitionDto;
const labels: Record<Tab, string> = { products: '商品与规格', categories: '分类', tags: '标签', attributes: '共享属性' };
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const message = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
const generatedCode = (prefix: 'attr' | 'sku') => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const blankSku = (): SkuWrite => ({ skuCode: generatedCode('sku'), name: '默认规格', price: '0.00', stockQuantity: 0, isActive: true, attributes: [] });
const blankProduct = (): ProductWrite => ({ name: '', description: '', categoryId: null, tagIds: [], imageUrls: [], status: 'draft' });
const dataTypeLabel: Record<SellerDefinitionDto['dataType'], string> = { text: '文本', number: '数值', boolean: '是 / 否', enum: '选项' };
const productStatusLabel = { draft: '草稿', active: '已上架', inactive: '已下架' } as const;
async function all<T>(path: string, signal?: AbortSignal) {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const result = await api<Page<T>>(`/seller/${path}?pageSize=50&page=${page}`, { signal });
    items.push(...result.items);
    if (items.length >= result.total || !result.items.length) return items;
  }
}
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="manage-field"><label htmlFor={id}>{label}</label>{cloneElement(children, { id })}</div>;
}
function Feedback({ error, note }: { error: string; note?: string }) { return <>{error && <p className="auth-error" role="alert">{error}</p>}{note && <p className="manage-success" role="status">{note}</p>}</>; }
function ImagePreview({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <span className="manage-image-failed">图片加载失败</span> : <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)}/>;
}
function ConfirmAction({ title, children, busy, onCancel, onConfirm }: { title: string; children: ReactNode; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="manage-confirm" role="group" aria-label={title}><strong>{title}</strong>{children}<div className="manage-actions"><button disabled={busy} onClick={onConfirm}>确认操作</button><button disabled={busy} onClick={onCancel}>取消操作</button></div></div>;
}
function LookupEditor({ tab, row, onSaved, onClose }: { tab: Exclude<Tab, 'products'>; row: Lookup | null; onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState(row?.name ?? '');
  const [description, setDescription] = useState(row && 'description' in row ? row.description ?? '' : '');
  const [sortOrder, setSortOrder] = useState(row?.sortOrder ?? 0);
  const [active, setActive] = useState(row && 'isActive' in row ? row.isActive : true);
  const [group, setGroup] = useState(row && 'groupName' in row ? row.groupName ?? '' : '');
  const [code] = useState(() => row && 'code' in row ? row.code : generatedCode('attr'));
  const [dataType, setDataType] = useState<SellerDefinitionDto['dataType']>(row && 'dataType' in row ? row.dataType : 'text');
  const [unit, setUnit] = useState(row && 'unit' in row ? row.unit ?? '' : '');
  const [options, setOptions] = useState(row && 'options' in row ? row.options?.join('\n') ?? '' : '');
  const [filterable, setFilterable] = useState(row && 'isFilterable' in row ? row.isFilterable : true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    const value = tab === 'attributes' ? { name, code, dataType, unit: dataType === 'number' ? unit.trim() || null : null, options: dataType === 'enum' ? options.split('\n').map((v) => v.trim()).filter(Boolean) : null, isFilterable: filterable, sortOrder }
      : { name, description: description.trim() || null, sortOrder, isActive: active, ...(tab === 'tags' ? { groupName: group.trim() || null } : {}) };
    try { await api(`/seller/${tab}${row ? `/${row.id}` : ''}`, json(row ? 'PUT' : 'POST', { ...value, ...(row ? { version: row.version } : {}) })); onSaved(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="manage-editor" aria-label={`${row ? '编辑' : '新建'}${labels[tab]}`}><h3>{row ? '编辑' : '新建'}{labels[tab]}</h3>

    <form onSubmit={(e) => { void save(e); }}><fieldset disabled={busy}><div className="manage-fields">
      <Field label="名称"><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)}/></Field>
      {tab !== 'attributes' && <Field label="说明"><textarea maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)}/></Field>}
      {tab === 'tags' && <Field label="标签分组"><input maxLength={40} value={group} onChange={(e) => setGroup(e.target.value)}/></Field>}
      {tab === 'attributes' && <>
        <Field label="属性类型"><select value={dataType} onChange={(e) => setDataType(e.target.value as typeof dataType)}><option value="text">文本</option><option value="number">数值</option><option value="boolean">是 / 否</option><option value="enum">枚举</option></select></Field>
        {dataType === 'number' && <Field label="单位"><input maxLength={24} value={unit} onChange={(e) => setUnit(e.target.value)}/></Field>}
        {dataType === 'enum' && <Field label="枚举选项（每行一个）"><textarea required data-validate="enum-options" value={options} onChange={(e) => setOptions(e.target.value)}/></Field>}
        <label className="manage-check"><input type="checkbox" checked={filterable} onChange={(e) => setFilterable(e.target.checked)}/>开放买家筛选</label>
      </>}
      <details className="manage-advanced"><summary>更多设置</summary><Field label="展示顺序（数字越小越靠前）"><input type="number" required min={-100000} max={100000} value={sortOrder} onChange={(e) => setSortOrder(e.target.valueAsNumber)}/></Field></details>
      {tab !== 'attributes' && <label className="manage-check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/>启用</label>}
    </div><Feedback error={error}/><div className="manage-actions"><button className="primary-action" type="submit">{busy ? '保存中…' : '保存'}</button><button type="button" onClick={onClose}>取消编辑</button></div></fieldset></form></section>;
}
function LookupList({ tab, onChange }: { tab: Exclude<Tab, 'products'>; onChange: () => void }) {
  const [page, setPage] = useState(1), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const targetSelect = useRef<HTMLSelectElement>(null);
  const [result, setResult] = useState<Page<Lookup>>(), [editing, setEditing] = useState<Lookup | null | undefined>();
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const [action, setAction] = useState<{ row: Lookup; type: 'delete' | 'merge' }>(), [targets, setTargets] = useState<SellerTagDto[]>([]), [targetId, setTargetId] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setResult(undefined); setError('');
    void api<Page<Lookup>>(`/seller/${tab}?page=${page}&pageSize=12&q=${encodeURIComponent(search)}`, { signal: controller.signal }).then(setResult).catch((e) => { if (e.name !== 'AbortError') setError(message(e)); });
    return () => controller.abort();
  }, [tab, page, search, revision]);
  function saved() { setEditing(undefined); setAction(undefined); setRevision((v) => v + 1); setNote('已保存'); onChange(); }
  async function merge(row: Lookup) {
    setError(''); setBusy(true);
    try { const tags = await all<SellerTagDto>('tags'); setTargets(tags.filter((t) => t.id !== row.id && t.isActive)); setTargetId(''); setAction({ row, type: 'merge' }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!action || busy) return;
    if (action.type === 'merge' && !targetId) { targetSelect.current?.reportValidity(); return; }
    setBusy(true); setError(''); setNote('');
    try {
      if (action.type === 'delete') await api(`/seller/${tab}/${action.row.id}`, json('DELETE', { version: action.row.version }));
      else {
        const target = targets.find((t) => t.id === targetId); if (!target) throw new Error('请选择目标标签');
        await api(`/seller/tags/${action.row.id}/merge`, json('POST', { targetId, version: action.row.version, targetVersion: target.version }));
      }
      saved();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <>
    <div className="manage-module-summary"><div><strong>{labels[tab]}管理</strong></div><div className="manage-inline-stats"><span>当前记录 <b>{result?.total ?? '—'}</b></span></div></div>
    <div className="manage-toolbar"><form onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query); setRevision((v) => v + 1); }}><input aria-label={`搜索${labels[tab]}`} placeholder="按名称搜索" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)}/><button>搜索</button></form><button className="primary-action" onClick={() => { setEditing(null); setAction(undefined); setNote(''); }}>新建{labels[tab]}</button><button onClick={() => { setRevision((v) => v + 1); setEditing(undefined); setAction(undefined); }}>重新加载</button></div>
    <Feedback error={error} note={note}/>
    {editing !== undefined && <ManageDialog title={`${editing ? '编辑' : '新建'}${labels[tab]}`} onClose={() => setEditing(undefined)}><LookupEditor key={`${tab}-${editing?.id ?? 'new'}`} tab={tab} row={editing} onClose={() => setEditing(undefined)} onSaved={saved}/></ManageDialog>}
    {action && <ManageDialog title={action.type === 'delete' ? `删除“${action.row.name}”` : `合并“${action.row.name}”`} onClose={() => setAction(undefined)}><ConfirmAction title={action.type === 'delete' ? `删除“${action.row.name}”` : `合并“${action.row.name}”`} busy={busy} onCancel={() => setAction(undefined)} onConfirm={() => { void execute(); }}>
      {action.type === 'delete' ? <p>仅允许删除没有关联的记录。此操作不可撤销。</p> : <><p>将全部商品绑定迁移到目标标签，自动去重，并停用来源标签。</p><Field label="目标标签"><select ref={targetSelect} required value={targetId} onChange={(e) => setTargetId(e.target.value)}><option value="">请选择启用标签</option>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></>}
    </ConfirmAction></ManageDialog>}
    {!result ? !error && <p role="status">正在加载…</p> : <><div className="manage-list">{result.items.map((row) => <article className="manage-row" key={row.id}><div className="manage-row-content"><strong>{row.name}</strong><p>{'code' in row ? `${dataTypeLabel[row.dataType]}属性${row.unit ? ` · 单位 ${row.unit}` : ''} · 已用于 ${row.valueCount} 个规格${row.isFilterable ? ' · 可用于筛选' : ''}` : `${row.isActive ? '启用' : '停用'} · ${row.productCount} 件关联商品${'groupName' in row && row.groupName ? ` · ${row.groupName}` : ''}`}</p>{'description' in row && row.description && <p className="manage-row-description">{row.description}</p>}</div><div className="manage-actions"><button disabled={busy} onClick={() => { setEditing(row); setAction(undefined); setNote(''); }}>编辑</button>{tab === 'tags' && <button disabled={busy} onClick={() => { setEditing(undefined); void merge(row); }}>合并</button>}<button disabled={busy} onClick={() => { setEditing(undefined); setAction({ row, type: 'delete' }); setNote(''); }}>删除</button></div></article>)}{!result.items.length && <p className="muted">暂无匹配记录。</p>}</div><Pager page={page} total={result.total} onPage={setPage}/></>}
  </>;
}
function Pager({ page, total, onPage }: { page: number; total: number; onPage: (n: number) => void }) { return <div className="manage-pagination"><span>共 {total} 条 · 第 {page} 页</span><button disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button><button disabled={page * 12 >= total} onClick={() => onPage(page + 1)}>下一页</button></div>; }
function SkuFields({ value, onChange, definitions, fixedCode = false }: { value: SkuWrite; onChange: (value: SkuWrite) => void; definitions: SellerDefinitionDto[]; fixedCode?: boolean }) {
  const change = (patch: Partial<SkuWrite>) => onChange({ ...value, ...patch });
  function attribute(index: number, next: string | boolean) { change({ attributes: value.attributes.map((a, i) => i === index ? { ...a, value: next } : a) }); }
  return <><div className="manage-fields">
    <Field label="规格名称"><input required maxLength={120} value={value.name} onChange={(e) => change({ name: e.target.value })}/></Field>
    <Field label="单价（元）"><input required inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,2})?" title="请输入非负金额，最多 10 位整数、2 位小数" value={value.price} onChange={(e) => change({ price: e.target.value })}/></Field>
    <Field label="库存数量"><input required type="number" min={0} max={2147483647} value={value.stockQuantity} onChange={(e) => change({ stockQuantity: e.target.valueAsNumber })}/></Field>
    <label className="manage-check"><input type="checkbox" checked={value.isActive} onChange={(e) => change({ isActive: e.target.checked })}/>启用规格</label>
  </div><details className="manage-advanced"><summary>商家货号（可选）</summary><Field label="商家货号"><input required disabled={fixedCode} title={fixedCode ? '创建后不可修改' : '已自动生成，可填写自有货号'} maxLength={64} value={value.skuCode} onChange={(e) => change({ skuCode: e.target.value })}/></Field></details><h4>规格属性</h4>
    {value.attributes.map((a, index) => {
      const d = definitions.find((d) => d.id === a.attributeId);
      return <div className="manage-attribute" key={a.attributeId}><Field label={`${d?.name ?? '属性'}${d?.unit ? `（${d.unit}）` : ''}`}>
        {d?.dataType === 'boolean' ? <select value={String(a.value)} onChange={(e) => attribute(index, e.target.value === 'true')}><option value="true">是</option><option value="false">否</option></select>
          : d?.dataType === 'enum' ? <select required value={String(a.value)} onChange={(e) => attribute(index, e.target.value)}><option value="">请选择</option>{d.options?.map((v) => <option key={v}>{v}</option>)}</select>
          : <input required maxLength={255} inputMode={d?.dataType === 'number' ? 'decimal' : 'text'} pattern={d?.dataType === 'number' ? '-?[0-9]{1,14}(\\.[0-9]{1,4})?' : undefined} title={d?.dataType === 'number' ? '请输入最多 14 位整数、4 位小数的数值' : undefined} value={String(a.value)} onChange={(e) => attribute(index, e.target.value)}/>}
      </Field><button type="button" aria-label={`移除${d?.name ?? '属性'}`} onClick={() => change({ attributes: value.attributes.filter((_, i) => i !== index) })}>移除</button></div>;
    })}
    {value.attributes.length < 20 && <Field label="添加属性"><select value="" onChange={(e) => { const d = definitions.find((d) => d.id === e.target.value); if (d) change({ attributes: [...value.attributes, { attributeId: d.id, value: d.dataType === 'boolean' ? false : '' }] }); }}><option value="">选择共享属性</option>{definitions.filter((d) => !value.attributes.some((a) => a.attributeId === d.id)).map((d) => <option key={d.id} value={d.id}>{d.name}{d.unit ? `（${d.unit}）` : ''}</option>)}</select></Field>}
  </>;
}
function ProductImages({ urls, onChange, disabled, onError, onUploading }: { urls: string[]; onChange: (urls: string[]) => void; disabled: boolean; onError: (message: string) => void; onUploading: (busy: boolean) => void }) {
  const [url, setUrl] = useState(''), [uploading, setUploading] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    if (urls.length + files.length > MAX_PRODUCT_IMAGES) { onError(`每个商品最多 ${MAX_PRODUCT_IMAGES} 张图片`); return; }
    setUploading(true); onUploading(true); onError('');
    const added: string[] = [];
    try {
      for (const file of Array.from(files)) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024 || file.size === 0) throw new Error('请选择不超过 4 MB 的 JPG、PNG 或 WebP 图片');
        const result = await api<{ url: string }>('/seller/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        added.push(result.url);
      }
      onChange([...urls, ...added]);
    } catch (error) { if (added.length) onChange([...urls, ...added]); onError(message(error)); }
    finally { setUploading(false); onUploading(false); }
  }
  function addUrl() {
    const candidate = url.trim();
    if (!/^https?:\/\//i.test(candidate)) { urlInput.current?.reportValidity(); return; }
    if (urls.length >= MAX_PRODUCT_IMAGES) { onError(`每个商品最多 ${MAX_PRODUCT_IMAGES} 张图片`); return; }
    if (urls.includes(candidate)) { onError('这张图片已经添加'); return; }
    onChange([...urls, candidate]); setUrl(''); onError('');
  }
  return <section className="manage-image-section" aria-label="商品图片管理"><div className="manage-section-heading"><div><h4>商品图片</h4></div><span className="manage-image-count">{urls.length} / {MAX_PRODUCT_IMAGES}</span></div>
    <div className="manage-image-grid">{urls.map((image, index) => <div className="manage-image-card" key={`${image}-${index}`}><div className="manage-image-preview"><ImagePreview src={image} alt={`商品图片 ${index + 1}`}/>{index === 0 && <span className="manage-image-badge">封面</span>}</div><div className="manage-image-actions"><button type="button" disabled={disabled || uploading || index === 0} aria-label={`将第 ${index + 1} 张图片前移`} onClick={() => { const next = [...urls]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; onChange(next); }}>前移</button><button type="button" disabled={disabled || uploading || index === urls.length - 1} aria-label={`将第 ${index + 1} 张图片后移`} onClick={() => { const next = [...urls]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; onChange(next); }}>后移</button><button type="button" disabled={disabled || uploading} aria-label={`删除第 ${index + 1} 张图片`} onClick={() => onChange(urls.filter((_, i) => i !== index))}>删除</button></div></div>)}
      {urls.length < MAX_PRODUCT_IMAGES && <label className={`manage-image-upload ${disabled || uploading ? 'disabled' : ''}`}><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled || uploading} aria-label="上传商品图片" title="JPG、PNG、WebP，单张不超过 4 MB，最多 8 张" onChange={(event) => { void upload(event.target.files); event.target.value = ''; }}/><span>{uploading ? '上传中…' : '＋ 上传图片'}</span></label>}</div>
    <div className="manage-image-link"><Field label="或添加图片 URL"><input ref={urlInput} type="url" data-validate="image-url" placeholder="https://example.com/product.jpg" value={url} disabled={disabled || uploading || urls.length >= MAX_PRODUCT_IMAGES} onChange={(event) => setUrl(event.target.value)}/></Field><button type="button" disabled={disabled || uploading || !url.trim() || urls.length >= MAX_PRODUCT_IMAGES} onClick={addUrl}>添加链接</button></div>
  </section>;
}
function ProductEditor({ id, onSaved, onSkuSaved, onClose }: { id: string | null; onSaved: () => void; onSkuSaved: () => void; onClose: () => void }) {
  const [product, setProduct] = useState<ProductWrite>(blankProduct), [loaded, setLoaded] = useState<SellerProductDetailDto>();
  const [categories, setCategories] = useState<SellerCategoryDto[]>([]), [tags, setTags] = useState<SellerTagDto[]>([]), [definitions, setDefinitions] = useState<SellerDefinitionDto[]>([]);
  const [sku, setSku] = useState<SkuWrite>(blankSku), [skuId, setSkuId] = useState<string | null | undefined>();
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState(''), [note, setNote] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    const c = new AbortController(); setReady(false); setError('');
    void Promise.all([all<SellerCategoryDto>('categories', c.signal), all<SellerTagDto>('tags', c.signal), all<SellerDefinitionDto>('attributes', c.signal), id ? api<SellerProductDetailDto>(`/seller/products/${id}`, { signal: c.signal }) : Promise.resolve(undefined)])
      .then(([cats, ts, ds, p]) => { setCategories(cats); setTags(ts); setDefinitions(ds); setLoaded(p); if (p) setProduct(p); setReady(true); setSkuId(undefined); })
      .catch((e) => { if (e.name !== 'AbortError') setError(message(e)); });
    return () => c.abort();
  }, [id, reload]);
  function change(patch: Partial<ProductWrite>) { setProduct((p) => ({ ...p, ...patch })); }
  function productPayload() { return { name: product.name, description: product.description?.trim() || null, categoryId: product.categoryId, tagIds: product.tagIds, imageUrls: product.imageUrls, status: product.status }; }
  const dirty = loaded && (product.name !== loaded.name || product.description !== loaded.description || product.categoryId !== loaded.categoryId || product.status !== loaded.status || JSON.stringify(product.tagIds) !== JSON.stringify(loaded.tagIds) || JSON.stringify(product.imageUrls) !== JSON.stringify(loaded.imageUrls));
  async function save(e: FormEvent) {
    e.preventDefault(); if (busy || uploading) return;
    if (productPayload().imageUrls.length > MAX_PRODUCT_IMAGES) { setError(`每个商品最多 ${MAX_PRODUCT_IMAGES} 张图片`); return; }
    setBusy(true); setError(''); setNote('');
    try {
      await api(`/seller/products${id ? `/${id}` : ''}`, json(id ? 'PUT' : 'POST', { ...productPayload(), ...(id ? { version: loaded!.version } : { defaultSku: sku }) }));
      onSaved();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function saveSku(e: FormEvent) {
    e.preventDefault(); if (busy || !loaded) return; setBusy(true); setError(''); setNote('');
    try {
      await api(`/seller/products/${id}/skus${skuId ? `/${skuId}` : ''}`, json(skuId ? 'PUT' : 'POST', { ...sku, ...(skuId ? { version: loaded.skus.find((s) => s.id === skuId)!.version } : {}) }));
      const refreshed = await api<SellerProductDetailDto>(`/seller/products/${id}`); setLoaded(refreshed); setProduct(refreshed); setSkuId(undefined); setNote('规格已保存'); onSkuSaved();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="manage-editor" aria-label="商品编辑器"><div className="manage-section-heading"><h3>{id ? '编辑商品与规格' : '新建商品'}</h3><button disabled={busy} onClick={onClose}>关闭编辑器</button></div>
    <Feedback error={error} note={note}/>{!ready ? <><p>{error ? '加载失败，请重试。' : '正在加载商品资料…'}</p><button onClick={() => setReload((v) => v + 1)}>重新加载商品</button></> : <>
    <form onSubmit={(e) => { void save(e); }}><fieldset disabled={busy || uploading || skuId !== undefined}><div className="manage-fields">
      <Field label="商品名称"><input required maxLength={160} value={product.name} onChange={(e) => change({ name: e.target.value })}/></Field>
      <Field label="商品状态"><select value={product.status} onChange={(e) => change({ status: e.target.value as ProductWrite['status'] })}><option value="draft">草稿</option><option value="active">上架</option><option value="inactive">下架</option></select></Field>
      <Field label="主分类（可选）"><select value={product.categoryId ?? ''} onChange={(e) => change({ categoryId: e.target.value || null })}><option value="">不归类</option>{categories.filter((c) => c.isActive || c.id === product.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}{!c.isActive ? '（已停用）' : ''}</option>)}</select></Field>
      <Field label="商品说明"><textarea maxLength={10000} value={product.description ?? ''} onChange={(e) => change({ description: e.target.value })}/></Field>
    </div><ProductImages urls={product.imageUrls} onChange={(imageUrls) => change({ imageUrls })} disabled={busy || skuId !== undefined} onError={setError} onUploading={setUploading}/><div className="manage-tag-picker" role="group" aria-label="商品标签"><h4>商品标签（最多 10 个）</h4>{tags.filter((t) => t.isActive || product.tagIds.includes(t.id)).map((t) => <label className="manage-check" key={t.id}><input type="checkbox" checked={product.tagIds.includes(t.id)} disabled={!product.tagIds.includes(t.id) && (!t.isActive || product.tagIds.length >= 10)} onChange={(e) => change({ tagIds: e.target.checked ? [...product.tagIds, t.id] : product.tagIds.filter((id) => id !== t.id) })}/>{t.name}{!t.isActive && '（停用，可解除）'}</label>)}</div>
    {!id && <div className="manage-sku-form"><h4>默认规格</h4><SkuFields value={sku} onChange={setSku} definitions={definitions}/></div>}
    <button className="primary-action" type="submit">{busy ? '保存中…' : id ? '保存商品信息' : '创建商品'}</button></fieldset></form>
    {loaded && <section className="manage-skus" aria-label="规格管理"><div className="manage-section-heading"><h3>商品规格 · {loaded.skus.length}</h3><button disabled={busy || !!dirty || skuId !== undefined || loaded.skus.length >= 20} onClick={() => { setSku(blankSku()); setSkuId(null); setError(''); setNote(''); }}>新增规格</button></div>
      {loaded.skus.map((s) => <article key={s.id} className="manage-row"><div className="manage-row-content"><strong>{s.name}</strong><p>¥{s.price} · 库存 {s.stockQuantity} · {s.isActive ? '启用' : '停用'}</p></div><button disabled={busy || !!dirty || skuId !== undefined} onClick={() => { setSku({ skuCode: s.skuCode, name: s.name, price: s.price, stockQuantity: s.stockQuantity, isActive: s.isActive, attributes: s.attributes }); setSkuId(s.id); setError(''); setNote(''); }}>编辑规格</button></article>)}
      {skuId !== undefined && <form className="manage-sku-form" aria-label="规格编辑器" onSubmit={(e) => { void saveSku(e); }}><fieldset disabled={busy}><h4>{skuId ? '编辑规格' : '新增规格'}</h4><SkuFields value={sku} onChange={setSku} definitions={definitions} fixedCode={!!skuId}/><div className="manage-actions"><button className="primary-action">{busy ? '保存中…' : '保存规格'}</button><button type="button" onClick={() => setSkuId(undefined)}>取消规格编辑</button></div></fieldset></form>}
    </section>}</>}
  </section>;
}
function ProductList({ counts }: { counts: { productCount: number; activeProductCount: number } }) {
  const [page, setPage] = useState(1), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [status, setStatus] = useState('');
  const [result, setResult] = useState<Page<SellerProductDto>>();
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [note, setNote] = useState(() => {
    const saved = sessionStorage.getItem('seller:product-saved');
    sessionStorage.removeItem('seller:product-saved');
    return saved ?? '';
  });
  useEffect(() => {
    const c = new AbortController(); setResult(undefined); setError('');
    void api<Page<SellerProductDto>>(`/seller/products?page=${page}&pageSize=12&q=${encodeURIComponent(search)}${status ? `&status=${status}` : ''}`, { signal: c.signal }).then(setResult).catch((e) => { if (e.name !== 'AbortError') setError(message(e)); });
    return () => c.abort();
  }, [page, search, status, revision]);
  return <><div className="manage-module-summary"><div><strong>商品目录</strong></div><div className="manage-inline-stats"><span>全部商品 <b>{counts.productCount}</b></span><span>已上架 <b>{counts.activeProductCount}</b></span></div></div><div className="manage-toolbar"><form onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query); setRevision((v) => v + 1); }}><input aria-label="搜索商品" placeholder="商品名称" maxLength={100} value={query} onChange={(e) => setQuery(e.target.value)}/><button>搜索</button></form><select aria-label="筛选商品状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">全部状态</option><option value="draft">草稿</option><option value="active">已上架</option><option value="inactive">已下架</option></select><button className="primary-action" onClick={() => { window.location.hash = '#/seller/products/new'; }}>新建商品</button><button onClick={() => { setRevision((v) => v + 1); }}>重新加载</button></div>
    <Feedback error={error} note={note}/>
    {!result ? !error && <p role="status">正在加载…</p> : <><div className="manage-list">{result.items.map((p) => <article key={p.id} className="manage-row manage-product-row"><div className="manage-product-cover">{p.imageUrls[0] ? <ImagePreview src={p.imageUrls[0]} alt={`${p.name}封面`}/> : <span>暂无图片</span>}</div><div className="manage-row-content"><strong>{p.name}</strong><p><span className={`manage-status status-${p.status}`}>{productStatusLabel[p.status]}</span> · {p.skuCount} 个规格 · {p.tagIds.length} 个标签</p></div><button onClick={() => { window.location.hash = `#/seller/products/${p.id}`; }}>编辑商品</button></article>)}{!result.items.length && <p className="muted">暂无匹配商品。</p>}</div><Pager page={page} total={result.total} onPage={setPage}/></>}
  </>;
}
export function SellerManager({ onChange, counts, canManageMembers }: { onChange: () => void; counts: { productCount: number; activeProductCount: number }; canManageMembers: boolean }) {
  const [tab, setTab] = useState<Tab>('products');
  return <section className="seller-manager" aria-label="商店管理"><div className="manage-section-heading"><div><h2>商店管理</h2></div></div>
    <nav className="manage-tabs" aria-label="管理模块">{(Object.keys(labels) as Tab[]).map((t) => <Fragment key={t}><button aria-pressed={tab === t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>{labels[t]}</button>{t === 'products' && canManageMembers && <a className="manage-tab-link" href="#/seller/members">店员管理</a>}{t === 'products' && <a className="manage-tab-link" href="#/seller/messages">咨询接待</a>}</Fragment>)}</nav>
    {tab === 'products' ? <ProductList counts={counts}/> : <LookupList key={tab} tab={tab} onChange={onChange}/>}
  </section>;
}
export function SellerProductEditorPage({ id }: { id: string | null }) {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const back = () => { window.location.hash = '#/seller'; };
  return <main className="workspace seller-edit-page"><div className="workspace-heading"><h1>{id ? '编辑商品与规格' : '新建商品'}</h1><a className="action-link" href="#/seller">← 返回商店管理</a></div><div className="seller-manager"><ProductEditor id={id} onClose={back} onSkuSaved={() => {}} onSaved={() => { sessionStorage.setItem('seller:product-saved', '商品已保存'); back(); }}/></div></main>;
}
