import type { Category, TxType } from '../../../api/src/types';
import { orderedCategories } from '../util';

interface Props {
  categories: Category[];
  type: TxType;
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  id?: string;
}

export function CategorySelect({ categories, type, value, onChange, allowNone, id }: Props) {
  return (
    <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {(allowNone || !value) && <option value="">未分類</option>}
      {orderedCategories(categories, type).map((c) => (
        <option key={c.id} value={c.id}>
          {c.parentId ? '　└ ' : ''}
          {c.icon} {c.name}
        </option>
      ))}
    </select>
  );
}
