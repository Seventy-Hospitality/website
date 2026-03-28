import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { AppShell } from '../components/AppShell';
import { MemberListView } from '../components/MemberListView';

export function MembersPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.listMembers({ limit: 100 })
      .then((result) => setMembers(result?.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <AppShell>
      <MemberListView
        members={members}
        loading={loading}
        onRefresh={load}
      />
    </AppShell>
  );
}
