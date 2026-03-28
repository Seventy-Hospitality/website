import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { AppShell } from '../components/AppShell';
import { MemberDetailView } from '../components/MemberDetailView';

export function MemberDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [member, setMember] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    if (!id) return;
    api.getMember(id).then(setMember);
  }

  useEffect(() => {
    if (!id) return;
    Promise.all([api.getMember(id), api.listPlans()])
      .then(([m, p]) => { setMember(m); setPlans(p); })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading || !member) {
    return <AppShell><div>Loading...</div></AppShell>;
  }

  return (
    <AppShell>
      <MemberDetailView member={member} plans={plans} onRefresh={reload} />
    </AppShell>
  );
}
