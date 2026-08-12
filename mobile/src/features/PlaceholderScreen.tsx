import { StyleSheet, Text, View } from 'react-native';
import { AppScreen } from '../components/AppScreen';
import { SectionCard } from '../components/SectionCard';
import { Badge } from '../components/Badge';
import { colors, spacing, typography } from '../theme/tokens';

interface PlaceholderScreenProps {
  title: string;
  subtitle: string;
  /** The flow package that fills this screen, e.g. "M2". */
  owner: string;
  body: string;
}

/**
 * A styled placeholder for a tab owned by a later flow package (mirrors the
 * web client's labelled PlaceholderPage convention). M0 ships the foundation;
 * M1..M6 replace these with their real screens.
 */
export function PlaceholderScreen({ title, subtitle, owner, body }: PlaceholderScreenProps) {
  return (
    <AppScreen>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      <SectionCard
        title="Coming soon"
        action={<Badge label={`${owner} package`} variant="accent" />}
      >
        <Text style={styles.body}>{body}</Text>
      </SectionCard>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs,
  },
  title: {
    ...typography.h1,
    color: colors.text,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
});
