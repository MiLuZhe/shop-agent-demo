import { useEffect, useState, type FormEvent } from 'react';
import type { Page, ShopMemberDto } from '@shop/contracts';
import { api } from '../api.ts';
import { ManageDialog } from './dialog.tsx';
import './styles.css';

const roles = { owner: '店长', manager: '经理', staff: '店员' };
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function MembersPage() {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const [result, setResult] = useState<Page<ShopMemberDto>>(), [page, setPage] = useState(1);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [revision, setRevision] = useState(0);
  const [createWork, setCreateWork] = useState(false), [displayName, setDisplayName] = useState(''), [password, setPassword] = useState('');
  const [username, setUsername] = useState(''), [role, setRole] = useState<'manager' | 'staff'>('staff');
  const [editing, setEditing] = useState<ShopMemberDto>(), [mode, setMode] = useState<'add' | 'edit' | null>(null), [editRole, setEditRole] = useState<'manager' | 'staff'>('staff'), [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setResult(undefined); setError('');
    void api<Page<ShopMemberDto>>(`/seller/members?page=${page}&q=${encodeURIComponent(search)}`, { signal: controller.signal })
      .then(setResult).catch((e: Error) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [page, search, revision]);
  async function save(event: FormEvent, edit = false) {
    event.preventDefault(); if (busy) return;
    if (!edit && createWork && (!displayName.trim() || !password.trim())) { setError(!displayName.trim() ? '请填写成员昵称' : '初始密码不能全部为空白字符'); return; }
    setBusy(true); setError(''); setNote('');
    try {
      if (edit && editing) await api(`/seller/members/${editing.id}`, json('PUT', { role: editRole, status, version: editing.version }));
      else await api(createWork ? '/seller/members/work-accounts' : '/seller/members', json('POST', createWork ? { username, displayName, password, role } : { username, role }));
      setMode(null); setPassword(''); setEditing(undefined); setUsername(''); setNote(edit ? '成员设置已保存' : '已添加店铺成员'); setRevision((v) => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }
  return <main className="workspace"><div className="workspace-heading"><h1>店员管理</h1><a className="action-link" href="#/seller">← 返回卖家工作台</a></div>
    <section className="seller-manager members-manager" aria-label="店员管理列表">
      <div className="manage-module-summary"><div><strong>店铺成员</strong></div><div className="manage-inline-stats"><span>当前成员 <b>{result?.total ?? '—'}</b></span></div></div>
      {note && <p className="manage-success" role="status">{note}</p>}{error && !mode && <p className="auth-error" role="alert">{error}</p>}
      <div className="manage-toolbar"><form onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query); setRevision((v) => v + 1); }}><input aria-label="搜索成员" placeholder="搜索本店账号或姓名" maxLength={50} value={query} onChange={(e) => setQuery(e.target.value)}/><button>搜索</button></form><button className="primary-action" onClick={() => { setUsername(''); setDisplayName(''); setPassword(''); setCreateWork(false); setRole('staff'); setMode('add'); setError(''); setNote(''); }}>添加成员</button><button disabled={busy} onClick={() => setRevision((v) => v + 1)}>重新加载</button></div>
      {!result ? !error && <p role="status">正在加载…</p> : result && <><div className="manage-list">{result.items.map((row) => <article className="manage-row" key={row.id}><div className="manage-row-content"><strong>{row.displayName}</strong><p>{row.username} · {roles[row.role]} · <span className={`manage-status ${row.status === 'active' ? 'status-active' : 'status-inactive'}`}>{row.status === 'active' ? '在岗' : '已停用'}</span>{row.userStatus === 'disabled' ? ' · 平台账号已停用' : ''}</p></div>
          {row.role === 'owner' ? <span className="muted">店长身份受保护</span> : <button disabled={busy} aria-label={`编辑 ${row.username}`} onClick={() => { setEditing(row); setEditRole(row.role as 'manager' | 'staff'); setStatus(row.status); setMode('edit'); setError(''); setNote(''); }}>编辑</button>}
        </article>)}{!result.items.length && <p className="muted">暂无匹配成员。</p>}</div><div className="manage-pagination"><span>共 {result.total} 位 · 第 {page} 页</span><button disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button><button disabled={busy || page * 12 >= result.total} onClick={() => setPage(page + 1)}>下一页</button></div></>}
    </section>
    {mode && <ManageDialog title={mode === 'add' ? '添加成员' : `编辑成员：${editing?.username ?? ''}`} onClose={() => { if (!busy) { setMode(null); setPassword(''); } }}><section className="manage-editor" aria-label={mode === 'edit' ? '编辑成员' : '添加成员表单'}><h2>{mode === 'add' ? '添加成员' : `编辑成员：${editing?.displayName}`}</h2>{error && <p className="auth-error" role="alert">{error}</p>}
      <form onSubmit={(e) => { void save(e, mode === 'edit'); }}><fieldset disabled={busy}><div className="manage-fields">{mode === 'add' ? <><label className="manage-field">添加方式<select aria-label="添加方式" value={createWork ? 'create' : 'existing'} onChange={(e) => { setCreateWork(e.target.value === 'create'); setPassword(''); }}><option value="existing">添加已有工作账号</option><option value="create">创建工作账号</option></select></label><label className="manage-field">成员账号<input required minLength={createWork ? 3 : 1} pattern={createWork ? '[A-Za-z0-9_]{3,50}' : undefined} maxLength={50} autoComplete="off" value={username} autoCapitalize="none" onChange={(e) => setUsername(e.target.value)}/></label>{createWork && <><label className="manage-field">成员昵称<input required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)}/></label><label className="manage-field">初始密码<input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}/></label></>}<label className="manage-field">添加角色<select aria-label="添加角色" value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="staff">店员</option><option value="manager">经理</option></select></label></> : <><label className="manage-field">成员角色<select aria-label="成员角色" value={editRole} onChange={(e) => setEditRole(e.target.value as typeof editRole)}><option value="staff">店员</option><option value="manager">经理</option></select></label><label className="manage-field">成员状态<select aria-label="成员状态" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="active">启用</option><option value="disabled">停用</option></select></label></>}</div><div className="manage-actions"><button className="primary-action" type="submit">{busy ? '保存中…' : mode === 'add' ? '确认添加' : '保存成员'}</button><button type="button" onClick={() => { setMode(null); setPassword(''); }}>取消</button></div></fieldset></form></section></ManageDialog>}
  </main>;
}
