import { useNavigate } from 'react-router-dom';
import { DataTable, type DataTableColumn } from 'octahedron';
import { MembershipStatus } from './MembershipStatus';

interface MemberRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  membership: {
    status: string;
    plan: { name: string };
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
  createdAt: string;
}

const columns: DataTableColumn<MemberRow>[] = [
  {
    name: 'Name',
    cell: (row: MemberRow) => `${row.firstName} ${row.lastName}`,
    sortValue: (row: MemberRow) => `${row.lastName} ${row.firstName}`,
  },
  {
    name: 'Email',
    cell: (row: MemberRow) => row.email,
    sortValue: (row: MemberRow) => row.email,
  },
  {
    name: 'Plan',
    cell: (row: MemberRow) => row.membership?.plan.name ?? '—',
    maxWidth: 140,
  },
  {
    name: 'Status',
    align: 'center',
    cell: (row: MemberRow) => <MembershipStatus status={row.membership?.status ?? null} />,
    maxWidth: 120,
  },
];

interface MemberTableProps {
  members: MemberRow[];
  loading?: boolean;
}

export function MemberTable({ members, loading }: MemberTableProps) {
  const navigate = useNavigate();

  return (
    <DataTable
      rows={members}
      columns={columns}
      rowKey={(row) => row.id}
      onRowClick={(row: MemberRow) => navigate(`/members/${row.id}`)}
      loading={loading}
      emptyMessage="No members found"
      pagination={{ defaultPageSize: 20, showSizeChanger: true }}
    />
  );
}
