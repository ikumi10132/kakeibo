import type { Category, TxType } from '../../../api/src/types';

interface Props {
  categories: Category[];
  type: TxType;
  value: string | null;
  onChange: (id: string | null) => void;
}

/** 大分類を大きなボタン、選んだ大分類の子を小さなボタンで選ぶ。選択中をもう一度押すと未分類に戻る */
export function CategoryPicker({ categories, type, value, onChange }: Props) {
  const parents = categories.filter((c) => c.type === type && !c.parentId).sort((a, b) => a.order - b.order);
  const selected = categories.find((c) => c.id === value);
  const parentId = selected?.parentId ?? selected?.id ?? null;
  const children = parentId ? categories.filter((c) => c.parentId === parentId).sort((a, b) => a.order - b.order) : [];

  return (
    <fieldset className="picker">
      <legend>カテゴリー{!value && <span className="muted small">（未分類）</span>}</legend>
      <div className="picker-grid">
        {parents.map((p) => {
          const on = p.id === parentId;
          return (
            <button
              key={p.id}
              type="button"
              className={`picker-item${on ? ' active' : ''}`}
              aria-pressed={on}
              onClick={() => onChange(on && value === p.id ? null : p.id)}
            >
              <span className="picker-icon" aria-hidden>{p.icon}</span>
              <span className="picker-name">{p.name}</span>
            </button>
          );
        })}
      </div>
      {children.length > 0 && (
        <div className="picker-children" role="group" aria-label="小分類">
          {children.map((c) => {
            const on = c.id === value;
            return (
              <button
                key={c.id}
                type="button"
                className={`chip-button${on ? ' active' : ''}`}
                aria-pressed={on}
                onClick={() => onChange(on ? parentId : c.id)}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
