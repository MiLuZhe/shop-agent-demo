import { useState, type FormEvent } from 'react';
import type { AccountDto, AccountRenameDto } from '@shop/contracts';
import { api, ApiRequestError } from '../api.ts';
import { AddressBook } from './addresses.tsx';
import { Dialog } from '../dialog.tsx';

const json = (body: unknown) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function AccountSettings({ account, mode, onUpdated, onReauthenticate }: { account: AccountDto; mode: 'profile' | 'security'; onUpdated: (value: AccountDto) => void; onReauthenticate: (username: string, reason: 'username' | 'password') => void }) {
  const [displayName, setDisplayName] = useState(account.user.displayName), [username, setUsername] = useState(account.user.username), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState(''), [availability, setAvailability] = useState(''), [uncertain, setUncertain] = useState(false);
  const [passwordCurrent, setPasswordCurrent] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [editor, setEditor] = useState<'username' | 'password'>();
  function closeEditor() {
    if (busy) return;
    setEditor(undefined); setPassword(''); setPasswordCurrent(''); setNewPassword(''); setConfirmation('');
    setAvailability(''); if (!uncertain) { setError(''); setNote(''); }
  }
  function openEditor(value: 'username' | 'password') {
    setUsername(account.user.username); setAvailability('');
    if (!uncertain) { setError(''); setNote(''); }
    setEditor(value);
  }
  const feedback = <>{error && <p className="auth-error" role="alert">{error}</p>}{note && <p className="account-note" role="status">{note}</p>}{uncertain && <a className="text-action" href="#/login">前往登录核实</a>}</>;
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNote('');
    try { const value = await api<AccountDto>('/account/profile', json({ displayName, version: account.version })); onUpdated(value); setNote('昵称已保存'); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  }
  async function check() {
    if (busy) return; setBusy(true); setError(''); setAvailability('');
    try { const value = await api<{ available: boolean }>(`/account/username-availability?username=${encodeURIComponent(username)}`); setAvailability(value.available ? '账号可以使用' : '账号已被使用或保留，请更换账号'); }
    catch (e) { setError(e instanceof Error ? e.message : '暂时无法检查'); }
    finally { setBusy(false); }
  }
  async function rename(event: FormEvent) {
    event.preventDefault(); if (busy || uncertain) return; setBusy(true); setError(''); setNote('');
    try {
      const value = await api<AccountRenameDto>('/account/username', json({ username, currentPassword: password, version: account.version }));
      if (value.reauthenticate) onReauthenticate(value.username, 'username');
      else setNote('账号没有变化');
    } catch (e) {
      if (!(e instanceof ApiRequestError) || e.status >= 500 || e.code === 'INVALID_RESPONSE') { setUncertain(true); setError('修改结果暂时无法确认，请重新加载账号资料，或尝试使用新账号登录。'); }
      else setError(e.message);
    } finally { setPassword(''); setBusy(false); }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault(); if (busy || uncertain) return; setError(''); setNote('');
    if (newPassword !== confirmation) { setError('两次新密码不一致'); return; }
    if (newPassword === passwordCurrent) { setError('新密码不能与当前密码相同'); return; }
    if (!newPassword.trim()) { setError('新密码不能全部为空白字符'); return; }
    setBusy(true);
    try {
      const value = await api<AccountRenameDto>('/account/password', json({ currentPassword: passwordCurrent, newPassword, confirmPassword: confirmation, version: account.version }));
      onReauthenticate(value.username, 'password');
    } catch (e) {
      if (!(e instanceof ApiRequestError) || e.status >= 500 || e.code === 'INVALID_RESPONSE') { setUncertain(true); setError('修改结果暂时无法确认，请尝试使用新密码登录，或重新加载账号资料。'); }
      else setError(e.message);
    } finally { setPasswordCurrent(''); setNewPassword(''); setConfirmation(''); setBusy(false); }
  }
  return <section className="account-settings" aria-label="账号设置">
    {mode === 'profile' ? <><h3>编辑昵称</h3>
    <form onSubmit={(e) => { void saveProfile(e); }}><fieldset disabled={busy || uncertain}>
      <div className="form-field"><label htmlFor="account-nickname">昵称</label><input id="account-nickname" required maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)}/></div>
      <button className="primary-action" disabled={displayName.trim() === account.user.displayName || !displayName.trim()}>保存昵称</button>
    </fieldset></form>{feedback}</> : <>
    <div className="security-actions">
      <div className="security-action"><div><h3>登录账号</h3><p className="muted">{account.user.username}</p></div><button type="button" onClick={() => openEditor('username')}>修改账号</button></div>
      <div className="security-action"><div><h3>登录密码</h3></div><button type="button" onClick={() => openEditor('password')}>修改密码</button></div>
    </div>
    {!editor && uncertain && feedback}
    {editor === 'username' && <Dialog title="修改账号" busy={busy} onClose={closeEditor}><p className="muted">修改后需重新登录，旧账号将停用且不能再次使用。</p>
    <form onSubmit={(e) => { void rename(e); }}><fieldset disabled={busy || uncertain}>
      <div className="form-field"><label htmlFor="account-username">新账号</label><input id="account-username" placeholder="3–50 位字母、数字或下划线" required minLength={3} maxLength={50} pattern="[A-Za-z0-9_]{3,50}" title="账号只能使用 3–50 位字母、数字或下划线" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => { setUsername(e.target.value); setAvailability(''); }}/></div>
      <button type="button" onClick={() => { void check(); }} disabled={!/^[a-z0-9_]{3,50}$/i.test(username)}>检查账号是否可用</button>
      {availability && <p role="status">{availability}</p>}
      <div className="form-field"><label htmlFor="account-password">当前密码</label><input id="account-password" type="password" required maxLength={128} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}/></div>
      <button className="primary-action" disabled={username.trim().toLowerCase() === account.user.username}>保存账号并重新登录</button>
    </fieldset></form>
    {feedback}</Dialog>}
    {editor === 'password' && <Dialog title="修改密码" busy={busy} onClose={closeEditor}><p className="muted">修改后需在所有设备重新登录。</p>
    <form onSubmit={(e) => { void changePassword(e); }} aria-label="修改密码"><fieldset disabled={busy || uncertain}>
      <div className="form-field"><label htmlFor="password-current">修改密码的当前密码</label><input id="password-current" type="password" autoComplete="current-password" required maxLength={128} value={passwordCurrent} onChange={(e) => setPasswordCurrent(e.target.value)}/></div>
      <div className="form-field"><label htmlFor="password-new">新密码</label><input id="password-new" placeholder="12–128 个字符" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}/></div>
      <div className="form-field"><label htmlFor="password-confirm">确认新密码</label><input id="password-confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={(e) => setConfirmation(e.target.value)}/></div>
      <button className="primary-action">保存密码并重新登录</button>
    </fieldset></form>{feedback}</Dialog>}
    </>}
    {mode === 'profile' && account.user.canShop && <AddressBook/>}
  </section>;
}
