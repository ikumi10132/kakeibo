import { useEffect, useState, type FormEvent } from 'react';
import type { AdminUser } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { currentUsername } from '../auth';

const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: '利用中',
  FORCE_CHANGE_PASSWORD: '初回ログイン前',
  RESET_REQUIRED: 'パスワード再設定待ち',
};

const PASSWORD_HINT = '12 文字以上で、英大文字・英小文字・数字・記号をそれぞれ含める';

/** 管理者だけが見られる、ログインユーザーの管理 */
export function AdminUsers({ toast, handleError }: Shared) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<'password' | 'email'>('password');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const me = currentUsername();

  const load = () => api.adminUsers().then(setUsers, handleError);
  useEffect(() => {
    void load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.adminCreateUser(email.trim(), mode === 'password' ? password : undefined);
      toast(
        mode === 'password'
          ? `${email} を追加しました。メールアドレスと仮パスワードを本人に伝えてください`
          : `${email} を追加し、仮パスワードをメールで送りました`,
      );
      setEmail('');
      setPassword('');
      await load();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast(message);
      await load();
    } catch (err) {
      handleError(err);
    }
  };

  const resetPassword = (u: AdminUser) => {
    const pw = prompt(`${u.email} の新しい仮パスワード (${PASSWORD_HINT})。次回ログイン時に本人が変更します`);
    if (pw) void run(() => api.adminUpdateUser(u.username, { password: pw }), '仮パスワードを設定しました。本人に伝えてください');
  };

  const remove = (u: AdminUser) => {
    if (!confirm(`${u.email} を削除しますか？\nログインできなくなります (家計簿のデータは残ります)。`)) return;
    void run(() => api.adminDeleteUser(u.username), '削除しました');
  };

  return (
    <>
      <section className="card">
        <h2 className="card-title">ユーザーを追加</h2>
        <form className="admin-form" onSubmit={add}>
          <label className="field">
            <span>メールアドレス</span>
            <input className="input" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <div className="segmented small-seg" role="group" aria-label="仮パスワードの渡し方">
            <button type="button" className={mode === 'password' ? 'active' : ''} onClick={() => setMode('password')}>
              自分で決めて伝える
            </button>
            <button type="button" className={mode === 'email' ? 'active' : ''} onClick={() => setMode('email')}>
              メールで送る
            </button>
          </div>
          {mode === 'password' ? (
            <label className="field">
              <span>仮パスワード ({PASSWORD_HINT})</span>
              <input className="input" type="text" required autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          ) : (
            <p className="muted small">Cognito から仮パスワードのメールが届きます (迷惑メールに入ることがあります)。</p>
          )}
          <p className="muted small">本人が初回ログインするときに、新しいパスワードを設定します。</p>
          <button className="btn btn-primary" disabled={busy}>追加</button>
        </form>
      </section>

      <section className="card">
        <h2 className="card-title">ユーザー一覧</h2>
        {!users && <p className="muted">読み込み中…</p>}
        <ul className="list">
          {users?.map((u) => {
            const self = u.username === me;
            return (
              <li key={u.username} className="user-row">
                <div className="grow">
                  <strong className="user-email">{u.email || u.username}</strong>
                  <span className="muted small">
                    {u.isAdmin && <span className="chip">管理者</span>}
                    {!u.enabled && <span className="chip chip-danger">停止中</span>}
                    {self && <span className="chip">自分</span>} {STATUS_LABEL[u.status] ?? u.status}・{u.createdAt.slice(0, 10)} 追加
                  </span>
                </div>
                {!self && (
                  <div className="user-actions">
                    <button className="btn btn-small" onClick={() => resetPassword(u)}>仮パスワード</button>
                    <button
                      className="btn btn-small"
                      onClick={() =>
                        void run(() => api.adminUpdateUser(u.username, { enabled: !u.enabled }), u.enabled ? '停止しました' : '再開しました')
                      }
                    >
                      {u.enabled ? '停止' : '再開'}
                    </button>
                    <button className="btn btn-small btn-danger" onClick={() => remove(u)}>削除</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
