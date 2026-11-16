import { useEffect, useState, type FormEvent } from 'react';
import type { ApiToken, Category, CreatedToken, Rule, TxType } from '../../../api/src/types';
import { api } from '../api';
import type { Shared } from '../App';
import { isAdmin, logout } from '../auth';
import { AdminUsers } from './AdminUsers';
import { getConfig } from '../config';
import { categoryLabel, orderedCategories } from '../util';
import { CategorySelect } from './CategorySelect';

type Section = 'categories' | 'rules' | 'shortcut' | 'users';

export function Settings(props: Shared) {
  const [section, setSection] = useState<Section>('categories');
  return (
    <>
      <h1 className="page-title">設定</h1>
      <div className="segmented" role="tablist">
        {([
          ['categories', 'カテゴリー'],
          ['rules', '振り分け'],
          ['shortcut', 'ショートカット'],
          ...(isAdmin() ? ([['users', 'ユーザー']] as const) : []),
        ] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={section === id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>
      {section === 'categories' && <Categories {...props} />}
      {section === 'rules' && <Rules {...props} />}
      {section === 'shortcut' && <Shortcut {...props} />}
      {section === 'users' && isAdmin() && <AdminUsers {...props} />}
      <button className="btn btn-ghost" onClick={logout}>ログアウト</button>
    </>
  );
}

// ---------- カテゴリー ----------

const COLORS = ['#e8833a', '#e0b93a', '#3ab38e', '#2fa36b', '#4aa3df', '#5b8def', '#8c7ae6', '#a46ee0', '#e06ea8', '#9b8565', '#7a8aa6', '#8e8e93'];

type Draft = Omit<Category, 'id'> & { id?: string };

function Categories({ categories, reloadCategories, changed, toast, handleError }: Shared) {
  const [type, setType] = useState<TxType>('expense');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const list = orderedCategories(categories, type);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await reloadCategories();
      changed();
      toast(message);
      return true;
    } catch (e) {
      handleError(e);
      return false;
    }
  };

  /** 同じ階層の中で 1 つ上下に動かす */
  const move = (c: Category, delta: -1 | 1) => {
    const siblings = categories.filter((x) => x.type === c.type && x.parentId === c.parentId).sort((a, b) => a.order - b.order);
    const i = siblings.findIndex((x) => x.id === c.id);
    const other = siblings[i + delta];
    if (!other) return;
    // order が同じ値だと入れ替わらないので、並び順で振り直す
    const a = { ...c, order: (i + delta) * 10 };
    const b = { ...other, order: i * 10 };
    void run(() => Promise.all([api.updateCategory(a), api.updateCategory(b)]), '並び順を変更しました');
  };

  return (
    <section className="card">
      <div className="segmented small-seg">
        {(['expense', 'income'] as const).map((t) => (
          <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
            {t === 'expense' ? '支出' : '収入'}
          </button>
        ))}
      </div>
      <ul className="list">
        {list.map((c) => (
          <li key={c.id} className={`cat-row${c.parentId ? ' child' : ''}`}>
            <span className="tx-icon" style={{ background: c.color }} aria-hidden>{c.icon}</span>
            <span className="grow">{c.name}</span>
            <button className="btn btn-icon" aria-label={`${c.name}を上へ`} onClick={() => move(c, -1)}>↑</button>
            <button className="btn btn-icon" aria-label={`${c.name}を下へ`} onClick={() => move(c, 1)}>↓</button>
            <button className="btn btn-small" onClick={() => setDraft({ ...c })}>編集</button>
          </li>
        ))}
      </ul>
      <button
        className="btn btn-wide"
        onClick={() => setDraft({ name: '', type, parentId: null, icon: '📁', color: COLORS[0]!, order: (list.length + 1) * 10 })}
      >
        ＋ カテゴリーを追加
      </button>

      {draft && (
        <CategoryEditor
          draft={draft}
          categories={categories}
          onCancel={() => setDraft(null)}
          onDelete={draft.id ? () => { setDeleting(categories.find((c) => c.id === draft.id) ?? null); setDraft(null); } : undefined}
          onSave={async (d) => {
            const ok = await run(
              () => (d.id ? api.updateCategory(d as Category) : api.createCategory(d)),
              d.id ? 'カテゴリーを更新しました' : 'カテゴリーを追加しました',
            );
            if (ok) setDraft(null);
          }}
        />
      )}
      {deleting && (
        <DeleteCategory
          target={deleting}
          categories={categories}
          onCancel={() => setDeleting(null)}
          onDelete={async (moveTo) => {
            const ok = await run(() => api.deleteCategory(deleting.id, moveTo), 'カテゴリーを削除しました');
            if (ok) setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

function CategoryEditor({ draft, categories, onCancel, onSave, onDelete }: {
  draft: Draft;
  categories: Category[];
  onCancel: () => void;
  onSave: (d: Draft) => Promise<void>;
  onDelete?: () => void;
}) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const hasChildren = !!d.id && categories.some((c) => c.parentId === d.id);
  const parents = categories.filter((c) => !c.parentId && c.type === d.type && c.id !== d.id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSave(d);
    setBusy(false);
  };

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="sheet-head">
          <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>閉じる</button>
          <h2>{d.id ? 'カテゴリーの編集' : 'カテゴリーの追加'}</h2>
          <button type="submit" className="btn btn-primary btn-small" disabled={busy || !d.name.trim()}>保存</button>
        </div>
        <div className="field-row">
          <label className="field icon-field">
            <span>アイコン</span>
            <input className="input" value={d.icon} maxLength={8} onChange={(e) => setD({ ...d, icon: e.target.value })} />
          </label>
          <label className="field grow">
            <span>名前</span>
            <input className="input" value={d.name} maxLength={30} autoFocus onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>親カテゴリー</span>
          <select
            className="input"
            value={d.parentId ?? ''}
            disabled={hasChildren}
            onChange={(e) => setD({ ...d, parentId: e.target.value || null })}
          >
            <option value="">なし (大分類)</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
            ))}
          </select>
          {hasChildren && <span className="muted small">子カテゴリーがあるため変更できません</span>}
        </label>
        <div className="field">
          <span>色</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${d.color === c ? ' active' : ''}`}
                style={{ background: c }}
                aria-label={c}
                aria-pressed={d.color === c}
                onClick={() => setD({ ...d, color: c })}
              />
            ))}
          </div>
        </div>
        {onDelete && (
          <button type="button" className="btn btn-danger" onClick={onDelete}>このカテゴリーを削除</button>
        )}
      </form>
    </div>
  );
}

function DeleteCategory({ target, categories, onCancel, onDelete }: {
  target: Category;
  categories: Category[];
  onCancel: () => void;
  onDelete: (moveTo: string | null) => Promise<void>;
}) {
  const [moveTo, setMoveTo] = useState<string | null>(target.parentId);
  const [busy, setBusy] = useState(false);
  const others = categories.filter((c) => c.id !== target.id);
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <button className="btn btn-ghost btn-small" onClick={onCancel}>やめる</button>
          <h2>「{target.name}」を削除</h2>
          <span />
        </div>
        <p>このカテゴリーの明細と振り分けルールを、どのカテゴリーに移しますか？</p>
        <CategorySelect categories={others} type={target.type} value={moveTo} onChange={setMoveTo} allowNone />
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onDelete(moveTo);
            setBusy(false);
          }}
        >
          削除する
        </button>
      </div>
    </div>
  );
}

// ---------- 自動振り分けルール ----------

function Rules({ categories, toast, handleError }: Shared) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);

  const load = () => api.rules().then(setRules, handleError);
  useEffect(() => {
    void load();
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!keyword.trim() || !categoryId) return;
    try {
      await api.createRule(keyword.trim(), categoryId);
      setKeyword('');
      toast('ルールを追加しました');
      await load();
    } catch (err) {
      handleError(err);
    }
  };

  const remove = async (r: Rule) => {
    try {
      await api.deleteRule(r.id);
      await load();
    } catch (err) {
      handleError(err);
    }
  };

  return (
    <section className="card">
      <p className="muted small">
        店名にキーワードが含まれていると、そのカテゴリーで自動記録します (複数当てはまるときは長いキーワードを優先)。
        未確認の明細でカテゴリーを選ぶと、ここに自動で追加されます。
      </p>
      <form className="rule-form" onSubmit={add}>
        <input className="input" placeholder="店名のキーワード (例: セブン)" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <CategorySelect categories={categories} type="expense" value={categoryId} onChange={setCategoryId} />
        <button className="btn btn-primary" disabled={!keyword.trim() || !categoryId}>追加</button>
      </form>
      {!rules && <p className="muted">読み込み中…</p>}
      <ul className="list">
        {rules?.map((r) => (
          <li key={r.id} className="cat-row">
            <span className="grow">
              <strong>{r.keyword}</strong>
              <span className="muted"> → {categoryLabel(r.categoryId, categories)}</span>
              {r.auto && <span className="chip">自動</span>}
            </span>
            <button className="btn btn-small btn-ghost" aria-label={`${r.keyword}のルールを削除`} onClick={() => void remove(r)}>削除</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- ショートカット連携 ----------

function Shortcut({ toast, handleError }: Shared) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [name, setName] = useState('iPhone');
  const apiUrl = getConfig().apiUrl;

  const load = () => api.tokens().then(setTokens, handleError);
  useEffect(() => {
    void load();
  }, []);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました');
    } catch {
      toast('コピーできませんでした。長押しで選択してください', true);
    }
  };

  const issue = async () => {
    try {
      setCreated(await api.createToken(name));
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const revoke = async (t: ApiToken) => {
    if (!confirm(`「${t.name}」のトークンを無効にしますか？このトークンを使うショートカットは動かなくなります`)) return;
    try {
      await api.deleteToken(t.id);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  return (
    <>
      <section className="card">
        <h2 className="card-title">API トークン</h2>
        <p className="muted small">ショートカットから記録するときの合言葉です。他の人に見せないでください。</p>
        {created && (
          <div className="token-box">
            <p className="small"><strong>トークンは今だけ表示されます。</strong>コピーしてショートカットに貼り付けてください。</p>
            <code className="code">{created.token}</code>
            <button className="btn btn-primary" onClick={() => void copy(created.token)}>トークンをコピー</button>
          </div>
        )}
        <div className="rule-form">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="名前 (例: iPhone)" />
          <button className="btn btn-primary" onClick={() => void issue()}>発行</button>
        </div>
        <ul className="list">
          {tokens?.map((t) => (
            <li key={t.id} className="cat-row">
              <span className="grow">
                <strong>{t.name}</strong>
                <span className="muted small">
                  {' '}発行 {t.createdAt.slice(0, 10)}
                  {t.lastUsedAt ? `・最終利用 ${new Date(t.lastUsedAt).toLocaleString('ja-JP')}` : '・未使用'}
                </span>
              </span>
              <button className="btn btn-small btn-ghost" onClick={() => void revoke(t)}>無効にする</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card guide">
        <h2 className="card-title">① Apple Pay で払ったら自動で記録</h2>
        <ol>
          <li>ショートカットアプリ →「オートメーション」→「＋」→「<b>ウォレット</b>」(一覧の下のほう。上の検索欄に「ウォレット」と入れても出ます。iOS 17 以降)</li>
          <li>対象のカードを選び、「<b>すぐに実行</b>」にして「次へ」→「新規の空のショートカット」</li>
          <li>アクション「<b>URLの内容を取得</b>」を追加して、次のように設定
            <dl className="kv">
              <dt>URL</dt>
              <dd><code className="code">{apiUrl}/shortcut/transactions</code> <button className="btn btn-small" onClick={() => void copy(`${apiUrl}/shortcut/transactions`)}>コピー</button></dd>
              <dt>方法</dt><dd>POST</dd>
              <dt>ヘッダ</dt><dd><code>Authorization</code> ＝ <code>Bearer </code>＋トークン (半角スペースを 1 つ入れる)</dd>
              <dt>本文を要求</dt>
              <dd>JSON。テキスト項目を 3 つ追加
                <ul>
                  <li><code>amount</code> ＝ 変数「ショートカットの入力」の<b>金額</b></li>
                  <li><code>merchant</code> ＝ 同じく<b>加盟店</b></li>
                  <li><code>card</code> ＝ 同じく<b>カード</b> (または名前)</li>
                </ul>
              </dd>
            </dl>
          </li>
          <li>アクション「<b>辞書の値を取得</b>」でキー <code>message</code> を取り出し、「<b>通知を表示</b>」に渡す</li>
        </ol>
        <p className="muted small">店名がルールに当てはまらなかった支払いは「未確認」に入ります。</p>
      </section>

      <section className="card guide">
        <h2 className="card-title">② QR決済・現金を手早く記録</h2>
        <ol>
          <li>ショートカットアプリで新規ショートカット (名前: 例「家計簿に記録」)</li>
          <li>「<b>数字を要求</b>」(問い: 金額)</li>
          <li>「<b>URLの内容を取得</b>」: <code className="code">{apiUrl}/shortcut/categories</code>、ヘッダは①と同じ、方法 GET</li>
          <li>「<b>リストから選択</b>」で、③の結果からカテゴリーを選ぶ</li>
          <li>「<b>リスト</b>」に「QR決済」「現金」の 2 行を入れ、もう一度「<b>リストから選択</b>」で選ぶ (選んだ文字が支払方法になります)</li>
          <li>「<b>URLの内容を取得</b>」: ①と同じ URL・POST・ヘッダ。本文 JSON は
            <code>amount</code>＝入力した数字、<code>category</code>＝④で選んだ項目、<code>payment</code>＝⑤で選んだ項目
          </li>
          <li>「辞書の値を取得」(<code>message</code>) →「通知を表示」</li>
        </ol>
        <p className="muted small">ホーム画面に追加するか、設定 → アクセシビリティ → タッチ → 背面タップ に割り当てると便利です。</p>
      </section>

      <section className="card guide">
        <h2 className="card-title">③ カードの利用通知メールから自動で記録</h2>
        <p className="muted small">
          ウォレットに取引が表示されないカード (JCB の QUICPay など) は ① が動きません。
          カード会社の「カードご利用通知」メールを iPhone の「メール」アプリで受け取っていれば、届いたときに自動で記録できます (JCB の形式に対応)。
        </p>
        <ol>
          <li>カード会社の会員サイトで、利用通知メールを受け取る設定にする (JCB は MyJCB →「My安心設定」→ カード利用関連の通知)</li>
          <li>ショートカットアプリ →「オートメーション」→「＋」→「<b>メール</b>」</li>
          <li>「差出人」にカード会社の通知メールのアドレスを選び (件名で絞る場合は「件名に次を含む」に「ご利用」など)、「<b>すぐに実行</b>」にして「次へ」→「新規の空のショートカット」</li>
          <li>アクション「<b>URLの内容を取得</b>」を追加
            <dl className="kv">
              <dt>URL</dt>
              <dd><code className="code">{apiUrl}/shortcut/mail</code> <button className="btn btn-small" onClick={() => void copy(`${apiUrl}/shortcut/mail`)}>コピー</button></dd>
              <dt>方法</dt><dd>POST</dd>
              <dt>ヘッダ</dt><dd>なし (トークンは本文で送る)</dd>
              <dt>本文を要求</dt>
              <dd>JSON。テキスト項目を 2 つ追加
                <ul>
                  <li><code>token</code> ＝ 発行したトークン (<code>kb_</code> で始まる文字をそのまま貼り付け)</li>
                  <li><code>text</code> ＝ 変数「ショートカットの入力」の<b>コンテンツ</b></li>
                </ul>
              </dd>
            </dl>
          </li>
          <li>「<b>辞書の値を取得</b>」(キー <code>message</code>) →「<b>通知を表示</b>」</li>
        </ol>
        <p className="muted small">店名はカタカナで届きます (例: スターバツクス)。振り分けルールは小さい「ッ」なども同じとみなして比べます。同じメールで二重に記録されることはありません。</p>
      </section>
    </>
  );
}
