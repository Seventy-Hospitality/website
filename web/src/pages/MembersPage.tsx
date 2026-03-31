import { useCallback, useEffect, useState } from 'react';
import { SplitContainer, Panel, useSelection, usePanelLayout } from 'octahedron';
import { api } from '../lib/api';
import { AppShell } from '../components/AppShell';
import { MemberListView } from '../components/MemberListView';
import { MemberInspector } from '../components/MemberInspector';
import { CreateMemberDialog } from '../components/CreateMemberDialog';

export function MembersPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const selection = useSelection({ urlParam: 'id' });
  const layout = usePanelLayout({
    panelId: 'inspector',
    isOpen: selection.selectedId != null,
    storagePrefix: 'members',
    defaultWidth: 400,
    minWidth: 320,
  });

  const load = useCallback(() => {
    setLoading(true);
    api.listMembers({ limit: 250 })
      .then((result) => setMembers(result?.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const selectedMember = members.find((m) => m.id === selection.selectedId);

  function handleCreated(memberId: string) {
    setShowCreate(false);
    load();
    selection.select(memberId);
  }

  return (
    <AppShell>
      <SplitContainer
        ref={layout.containerRef}
        isCompact={layout.isCompact}
        activeCompactPanel={selection.selectedId ? 'inspector' : null}
        onNavigateBack={selection.deselect}
        openPanelIds={selection.selectedId ? ['inspector'] : []}
        mainPanelTitle="Members"
      >
        <Panel id="main" flex>
          <MemberListView
            members={members}
            loading={loading}
            onRefresh={load}
            onRowClick={(row) => selection.toggle(row.id)}
            onAddMember={() => setShowCreate(true)}
          />
        </Panel>

        <Panel
          id="inspector"
          width={layout.width}
          open={selection.selectedId != null}
          label="Member"
          title={selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : undefined}
          onClose={selection.deselect}
          onWidthChange={layout.setWidth}
          onWidthReset={layout.resetWidth}
        >
          {selection.selectedId && <MemberInspector memberId={selection.selectedId} />}
        </Panel>
      </SplitContainer>

      {showCreate && (
        <CreateMemberDialog
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      )}
    </AppShell>
  );
}
