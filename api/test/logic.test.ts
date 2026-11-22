import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCategories, defaultRules } from '../src/defaults.js';
import { categoryLabel, groupsFromClaim, isDate, matchRule, normalize, parseAmount, parseCardMail, todayJst } from '../src/logic.js';
import { isOpenAdvance, ownAmount, type Rule } from '../src/types.js';

test('ショートカットから届くさまざまな金額表記を円の整数にする', () => {
  assert.equal(parseAmount('¥1,234'), 1234);
  assert.equal(parseAmount('￥１，２３４'), 1234); // 全角
  assert.equal(parseAmount('JP¥980'), 980);
  assert.equal(parseAmount('1,500円'), 1500);
  assert.equal(parseAmount('1234.00'), 1234);
  assert.equal(parseAmount(' ¥ 3 000 '), 3000);
  assert.equal(parseAmount(450), 450);
  assert.equal(parseAmount(-450), 450);
  assert.throws(() => parseAmount('¥'), /読み取れません/);
  assert.throws(() => parseAmount('0'), /不正/);
  assert.throws(() => parseAmount(undefined), /ありません/);
});

test('店名に含まれるキーワードのうち、最も長いルールを使う', () => {
  const rules: Rule[] = [
    { id: '1', keyword: 'セブン', categoryId: 'food-grocery', auto: false },
    { id: '2', keyword: 'セブンカフェ', categoryId: 'food-cafe', auto: true },
    { id: '3', keyword: 'Apple.com', categoryId: 'subscription', auto: false },
  ];
  assert.equal(matchRule('セブン-イレブン 渋谷店', rules)?.id, '1');
  assert.equal(matchRule('ｾﾌﾞﾝｶﾌｪ', rules)?.id, '2'); // 半角カナもそろえて比較
  assert.equal(matchRule('APPLE.COM/BILL', rules)?.id, '3');
  assert.equal(matchRule('ローソン', rules), undefined);
  assert.equal(matchRule('', rules), undefined);
});

test('既定のカテゴリーは 2 階層まで、ルールは既存のカテゴリーを指す', () => {
  const cats = defaultCategories();
  const ids = new Set(cats.map((c) => c.id));
  assert.equal(ids.size, cats.length);
  for (const c of cats) {
    if (c.parentId) assert.equal(cats.find((p) => p.id === c.parentId)?.parentId, null);
  }
  for (const r of defaultRules()) assert.ok(ids.has(r.categoryId), r.keyword);
  assert.equal(categoryLabel('food-eatout', cats), '食費 > 外食');
  assert.equal(categoryLabel(null, cats), '未分類');
});

test('日付は日本時間で扱う', () => {
  assert.equal(todayJst(new Date('2026-11-14T15:30:00Z')), '2026-11-15');
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026/02/28'));
});

test('自分の負担額: 立て替えは受け取った額を引く (未精算は全額)', () => {
  assert.equal(ownAmount({ amount: 3000 }), 3000);
  assert.equal(ownAmount({ amount: 3000, advance: true, received: null }), 3000);
  assert.equal(ownAmount({ amount: 3000, advance: true, received: 2000 }), 1000);
  assert.equal(ownAmount({ amount: 3000, advance: true, received: 0 }), 3000);
  assert.ok(isOpenAdvance({ advance: true, received: null }));
  assert.ok(isOpenAdvance({ advance: true }));
  assert.ok(!isOpenAdvance({ advance: true, received: 0 }));
  assert.ok(!isOpenAdvance({ advance: false }));
  // waripo で割り勘にして自分が払った明細は、相手の負担を引く
  assert.equal(ownAmount({ amount: 6001, split: { entryId: 'e', role: 'payer', otherShare: 3000 } }), 3001);
  assert.equal(ownAmount({ amount: 3000, split: { entryId: 'e', role: 'partner' } }), 3000);
});

test('JWT の cognito:groups はさまざまな形で届く', () => {
  assert.deepEqual(groupsFromClaim(['admin']), ['admin']);
  assert.deepEqual(groupsFromClaim('[admin]'), ['admin']);
  assert.deepEqual(groupsFromClaim('[admin other]'), ['admin', 'other']);
  assert.deepEqual(groupsFromClaim('["admin","x"]'), ['admin', 'x']);
  assert.deepEqual(groupsFromClaim(undefined), []);
});

const JCB_MAIL = `作本　育海 様
カード名称　：　ＡＮＡＪＣＢワイドゴールドカード

JCBカードのご利用がありましたのでご連絡します。

【ご利用日時(日本時間)】　2026/11/16 13:12
【ご利用金額】　2,060円
【ご利用先】　ドンドン　ミナミイワクニテン

▼【ご利用先】について
　・国内の加盟店の場合、すべてカタカナ表示となります。（例：一休→イツキユウ）
　　例）Amazonプライム年会費　5,900円　　→　アマゾン　5,900円`;

test('JCB の利用通知メールから日付・金額・利用先を読む', () => {
  assert.deepEqual(parseCardMail(JCB_MAIL), {
    date: '2026-11-16',
    amount: 2060,
    merchant: 'ドンドン ミナミイワクニテン',
    card: 'ANAJCBワイドゴールドカード',
  });
  assert.equal(parseCardMail(JCB_MAIL.replace(/\n/g, '\r\n')).amount, 2060);
  assert.throws(() => parseCardMail('こんにちは'), /金額/);
  // HTML 形式の本文でも読める
  const html = '<html><body><p>【ご利用日時(日本時間)】&nbsp;2026/11/16 13:12<br>【ご利用金額】&nbsp;2,060円<br>【ご利用先】&nbsp;<b>ドンドン</b></p></body></html>';
  assert.deepEqual(parseCardMail(html), { date: '2026-11-16', amount: 2060, merchant: 'ドンドン', card: '' });
});

test('カード会社のカタカナ表記 (小さいカナが大きい) でもルールに当たる', () => {
  assert.equal(normalize('スターバツクス'), normalize('スターバックス'));
  assert.equal(normalize('せぶん'), normalize('セブン'));
  const rules = [{ id: '1', keyword: 'スターバックス', categoryId: 'food-cafe', auto: false }];
  assert.equal(matchRule('スターバツクス コーヒー シブヤテン', rules)?.id, '1');
});
