import type { Category, Rule } from './types.js';

type Seed = Omit<Category, 'order' | 'parentId'> & { children?: [string, string, string][] };

// 初回アクセス時に作るカテゴリー。画面から自由に変更・削除できる
// children: [id, 名前, アイコン]
const SEEDS: Seed[] = [
  { id: 'food', name: '食費', type: 'expense', icon: '🍙', color: '#e8833a', children: [
    ['food-grocery', '食料品', '🛒'], ['food-eatout', '外食', '🍜'], ['food-cafe', 'カフェ', '☕'],
  ] },
  { id: 'daily', name: '日用品', type: 'expense', icon: '🧻', color: '#4aa3df' },
  { id: 'transport', name: '交通費', type: 'expense', icon: '🚃', color: '#5b8def' },
  { id: 'hobby', name: '趣味・娯楽', type: 'expense', icon: '🎮', color: '#a46ee0' },
  { id: 'clothes', name: '衣服・美容', type: 'expense', icon: '👕', color: '#e06ea8' },
  { id: 'social', name: '交際費', type: 'expense', icon: '🍻', color: '#e0b93a' },
  { id: 'health', name: '医療・健康', type: 'expense', icon: '💊', color: '#3ab38e' },
  { id: 'utility', name: '水道・光熱費', type: 'expense', icon: '💡', color: '#6fb0c9' },
  { id: 'telecom', name: '通信費', type: 'expense', icon: '📱', color: '#7a8aa6' },
  { id: 'housing', name: '住まい', type: 'expense', icon: '🏠', color: '#9b8565' },
  { id: 'subscription', name: 'サブスク', type: 'expense', icon: '🔁', color: '#8c7ae6' },
  { id: 'other', name: 'その他', type: 'expense', icon: '📦', color: '#8e8e93' },
  { id: 'salary', name: '給与', type: 'income', icon: '💴', color: '#2fa36b' },
  { id: 'bonus', name: '賞与', type: 'income', icon: '🎁', color: '#3fbf7f' },
  { id: 'income-other', name: 'その他収入', type: 'income', icon: '➕', color: '#6cc79a' },
];

export function defaultCategories(): Category[] {
  const out: Category[] = [];
  SEEDS.forEach((s, i) => {
    out.push({ id: s.id, name: s.name, type: s.type, icon: s.icon, color: s.color, parentId: null, order: i * 10 });
    s.children?.forEach(([id, name, icon], j) =>
      out.push({ id, name, type: s.type, icon, color: s.color, parentId: s.id, order: j * 10 }),
    );
  });
  return out;
}

// よく使う店の初期ルール (画面から変更・削除できる)
const RULE_SEEDS: [string, string][] = [
  ['セブン', 'food-grocery'], ['ファミリーマート', 'food-grocery'], ['ローソン', 'food-grocery'],
  ['イオン', 'food-grocery'], ['スターバックス', 'food-cafe'], ['ドトール', 'food-cafe'],
  ['マクドナルド', 'food-eatout'], ['マツモトキヨシ', 'daily'], ['ウエルシア', 'daily'],
  ['suica', 'transport'], ['pasmo', 'transport'], ['icoca', 'transport'], ['jr', 'transport'],
  ['amazon', 'other'], ['ユニクロ', 'clothes'], ['apple.com', 'subscription'], ['netflix', 'subscription'],
];

export function defaultRules(): Rule[] {
  return RULE_SEEDS.map(([keyword, categoryId], i) => ({ id: `seed${i}`, keyword, categoryId, auto: false }));
}
