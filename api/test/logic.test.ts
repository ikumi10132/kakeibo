import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultCategories, defaultRules } from '../src/defaults.js';
import { categoryLabel, isDate, matchRule, parseAmount, todayJst } from '../src/logic.js';
import type { Rule } from '../src/types.js';

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
