import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DataTable,
  type DataTableColumn,
  SearchInput,
  ControlButton,
  ControlIconButton,
  Select,
  type SelectOption,
  Tag,
  AppIcon,
  RefreshCw,
  FilterPill,
  defineFilterColumns,
  rowMatchesFilters,
  listTableFilterOperators,
  formatTableFilterOperator,
  listColumnOptions,
  createFilterId,
  type TableFilter,

} from 'octahedron';
import { MembershipStatus } from './MembershipStatus';
import styles from './MemberListView.module.css';

interface MemberRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  membership: {
    status: string;
    plan: { name: string };
  } | null;
}

const { columns: filterColumns, columnsById: filterColumnsById } = defineFilterColumns([
  {
    id: 'status',
    label: 'Status',
    valueInput: 'select',
    getValues: (row) => row.membership?.status ?? 'none',
  },
  {
    id: 'plan',
    label: 'Plan',
    valueInput: 'select',
    getValues: (row) => row.membership?.plan.name ?? 'None',
  },
] as const);

type FilterColumnId = (typeof filterColumns)[number]['id'];

const columns: DataTableColumn<MemberRow>[] = [
  {
    name: 'Name',
    cell: (row) => `${row.firstName} ${row.lastName}`,
    sortValue: (row) => `${row.lastName} ${row.firstName}`,
  },
  {
    name: 'Email',
    cell: (row) => row.email,
    sortValue: (row) => row.email,
  },
  {
    name: 'Plan',
    cell: (row) => row.membership ? <Tag seed={row.membership.plan.name}>{row.membership.plan.name}</Tag> : '—',
    maxWidth: 180,
  },
  {
    name: 'Status',
    align: 'center',
    cell: (row) => <MembershipStatus status={row.membership?.status ?? null} />,
    maxWidth: 120,
  },
];

interface Props {
  members: MemberRow[];
  loading?: boolean;
  onRefresh?: () => void;
}

export function MemberListView({ members, loading, onRefresh }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<TableFilter<FilterColumnId>[]>([]);
  const [addFilterOpen, setAddFilterOpen] = useState(false);

  const addFilter = useCallback((filter: Omit<TableFilter<string>, 'id'>) => {
    setFilters((prev) => [...prev, { ...filter, id: createFilterId() }]);
  }, []);

  const removeFilter = useCallback((id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const updateFilter = useCallback((id: string, next: Omit<TableFilter<string>, 'id'>) => {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...next, id } : f)));
  }, []);

  const filterValueOptions = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const col of filterColumns) {
      if (col.valueInput === 'select') {
        map.set(col.id, listColumnOptions(members, col.getValues));
      }
    }
    return map;
  }, [members]);

  const addFilterOptions = useMemo((): SelectOption[] =>
    filterColumns.map((col) => ({
      value: col.id,
      label: col.label,
      onClick: () => {
        const operator = listTableFilterOperators(col.valueInput)[0]?.value ?? 'is';
        const value = col.valueInput === 'select' ? (filterValueOptions.get(col.id)?.[0] ?? '') : '';
        addFilter({ columnId: col.id, operator, value, combinator: 'and' });
      },
    })),
    [filterValueOptions, addFilter],
  );

  const filtered = useMemo(() => {
    let rows = members;

    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.firstName.toLowerCase().includes(q) ||
          r.lastName.toLowerCase().includes(q) ||
          r.email.toLowerCase().includes(q),
      );
    }

    if (filters.length) {
      rows = rows.filter((r) => rowMatchesFilters(r, filters, filterColumns));
    }

    return rows;
  }, [members, query, filters]);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarRow}>
          <Select
            options={addFilterOptions}
            position="bottom-left"
            open={addFilterOpen}
            onOpenChange={setAddFilterOpen}
            trigger={
              <ControlButton icon={<AppIcon name="filter" />}>
                Filter
              </ControlButton>
            }
          />

          <SearchInput
            id="member-search"
            value={query}
            onValueChange={setQuery}
            placeholder="Search members..."
          />

          {onRefresh && (
            <ControlIconButton
              ariaLabel="Refresh"
              icon={<RefreshCw size={12} />}
              onClick={onRefresh}
            />
          )}

          <ControlButton color="primary" onClick={() => navigate('/members/new')}>
            Add Member
          </ControlButton>
        </div>

        {filters.length > 0 && (
          <div className={styles.filtersRow}>
            {filters.map((filter) => {
              const col = filterColumnsById[filter.columnId];
              const operatorOptions = listTableFilterOperators(col?.valueInput ?? 'text');
              const valueOptions = filterValueOptions.get(filter.columnId) ?? [];

              return (
                <FilterPill
                  key={filter.id}
                  column={{
                    value: filter.columnId,
                    label: col?.label ?? filter.columnId,
                    options: filterColumns.map((c) => ({ value: c.id, label: c.label })),
                    onValueChange: (nextCol) => {
                      const nextDef = filterColumnsById[nextCol];
                      const ops = listTableFilterOperators(nextDef?.valueInput ?? 'text');
                      const nextOp = ops[0]?.value ?? 'is';
                      const nextVal = nextDef?.valueInput === 'select' ? (filterValueOptions.get(nextCol)?.[0] ?? '') : '';
                      updateFilter(filter.id, { columnId: nextCol as FilterColumnId, operator: nextOp, value: nextVal, combinator: filter.combinator });
                    },
                  }}
                  operator={{
                    value: filter.operator,
                    label: formatTableFilterOperator(filter.operator),
                    options: operatorOptions.map((o) => ({ value: o.value, label: o.label })),
                    onValueChange: (op) => updateFilter(filter.id, { ...filter, operator: op as any }),
                  }}
                  value={
                    col?.valueInput === 'select'
                      ? {
                          kind: 'select',
                          value: filter.value,
                          label: filter.value,
                          options: valueOptions.map((v) => ({ value: v, label: v })),
                          onValueChange: (v) => updateFilter(filter.id, { ...filter, value: v }),
                        }
                      : {
                          kind: 'text',
                          value: filter.value,
                          placeholder: '–',
                          onValueChange: (v) => updateFilter(filter.id, { ...filter, value: v }),
                        }
                  }
                  onRemove={() => removeFilter(filter.id)}
                  removeLabel={`Remove ${col?.label} filter`}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.tableArea}>
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/members/${row.id}`)}
          emptyMessage="No members found"
          loading={loading}
          pagination={{
            defaultPageSize: 50,
            showSizeChanger: true,
            showControls: true,
          }}
        />
      </div>
    </div>
  );
}
