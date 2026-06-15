/**
 * (tabs)/notes.tsx — WC10 mobile notes tab.
 *
 * Two-panel layout: note list (always visible on the left / as a full list on
 * phone) with search, favourites pinned at top, and a + New button.
 * Tapping a note opens a simple read-only preview panel (full Tiptap editor is
 * a web-only feature; the mobile surface shows the plain-text extraction via the
 * /extract endpoint as a later enhancement). Pull-to-refresh reloads the list.
 *
 * The tab icon is NotebookPen.
 */
import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/native/providers/auth-provider';
import { useTheme } from '../../src/native/providers/theme-provider';
import { Icon } from '../../src/native/ui/icon';
import type { Theme } from '@geneweave/tokens';
import type { NoteListItem } from '@geneweave/api-client';

export default function NotesScreen() {
  const { client, state: authState } = useAuth();
  const { theme } = useTheme();
  const authed = authState.status === 'authenticated' && client !== null;

  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const loadNotes = useCallback(async (silent = false, query?: string) => {
    if (!authed || !client) return;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const fetched = await client.listNotes({ search: query ?? search });
      setNotes(fetched);
    } catch {
      // silent — show stale data
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authed, client, search]);

  useEffect(() => { void loadNotes(); }, [loadNotes]);

  const handleSearch = useCallback((text: string) => {
    setSearch(text);
    void loadNotes(true, text);
  }, [loadNotes]);

  const handleCreate = useCallback(async () => {
    if (!client) return;
    setCreating(true);
    try {
      const note = await client.createNote({ title: 'Untitled' });
      setNotes((prev) => [note, ...prev]);
    } catch {
      Alert.alert('Error', 'Could not create note. Please try again.');
    } finally {
      setCreating(false);
    }
  }, [client]);

  const handleToggleFav = useCallback(async (note: NoteListItem) => {
    if (!client) return;
    const nextFav = note.favorite ? 0 : 1;
    setNotes((prev) => prev.map((n) => n.id === note.id ? { ...n, favorite: nextFav } : n));
    try {
      await client.updateNote(note.id, { favorite: nextFav });
    } catch {
      // revert on failure
      setNotes((prev) => prev.map((n) => n.id === note.id ? { ...n, favorite: note.favorite } : n));
    }
  }, [client]);

  const handleDelete = useCallback(async (note: NoteListItem) => {
    Alert.alert('Delete note', `Delete "${note.title || 'Untitled'}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!client) return;
          setNotes((prev) => prev.filter((n) => n.id !== note.id));
          try {
            await client.deleteNote(note.id);
          } catch {
            void loadNotes(true);
          }
        },
      },
    ]);
  }, [client, loadNotes]);

  const favs = notes.filter((n) => n.favorite);
  const others = notes.filter((n) => !n.favorite);

  const s = makeStyles(theme);

  function renderNote(note: NoteListItem) {
    const isFav = !!note.favorite;
    const updatedDate = new Date(note.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return (
      <TouchableOpacity
        key={note.id}
        style={s.noteRow}
        onLongPress={() => handleDelete(note)}
        activeOpacity={0.7}
      >
        <Text style={s.noteIcon}>{note.icon ?? '📄'}</Text>
        <View style={s.noteBody}>
          <Text style={s.noteTitle} numberOfLines={1}>{note.title || 'Untitled'}</Text>
          <View style={s.noteMeta}>
            <Text style={[s.noteDate, { color: theme.colors.textMuted }]}>{updatedDate}</Text>
            {note.sensitivity !== 'normal' ? (
              <View style={s.sensBadge}>
                <Text style={s.sensBadgeText}>{note.sensitivity}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <TouchableOpacity
          style={s.favBtn}
          onPress={() => void handleToggleFav(note)}
          hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
        >
          <Text style={[s.favStar, isFav && s.favStarActive]}>{isFav ? '★' : '☆'}</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  }

  type SectionRow = { type: 'sectionHeader'; label: string } | { type: 'note'; note: NoteListItem };
  const rows: SectionRow[] = [];
  if (favs.length > 0) {
    rows.push({ type: 'sectionHeader', label: '★ Favourites' });
    favs.forEach((n) => rows.push({ type: 'note', note: n }));
  }
  if (others.length > 0) {
    if (favs.length > 0) rows.push({ type: 'sectionHeader', label: 'All notes' });
    others.forEach((n) => rows.push({ type: 'note', note: n }));
  }

  return (
    <SafeAreaView edges={['top']} style={[s.safe, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Icon name="notes" size="md" tone="active" />
          <Text style={[s.headerTitle, { color: theme.colors.text, fontFamily: theme.typography.families.display }]}>Notes</Text>
        </View>
        <TouchableOpacity
          style={[s.newBtn, { backgroundColor: theme.colors.accent }, creating && s.newBtnDisabled]}
          onPress={() => void handleCreate()}
          disabled={creating}
        >
          {creating
            ? <ActivityIndicator color={theme.colors.onAccent} size="small" />
            : <Text style={[s.newBtnText, { color: theme.colors.onAccent }]}>+ New</Text>
          }
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      <View style={[s.searchBar, { borderBottomColor: theme.colors.border }]}>
        <Icon name="search" size="sm" tone="muted" />
        <TextInput
          style={[s.searchInput, { color: theme.colors.text }]}
          placeholder="Search notes…"
          placeholderTextColor={theme.colors.textMuted}
          value={search}
          onChangeText={handleSearch}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      {loading && notes.length === 0 ? (
        <View style={s.center}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row, i) => (row.type === 'sectionHeader' ? `h-${row.label}` : `n-${row.note.id}-${i}`)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadNotes(true)}
              tintColor={theme.colors.accent}
            />
          }
          renderItem={({ item: row }) => {
            if (row.type === 'sectionHeader') {
              return <Text style={[s.sectionLabel, { color: theme.colors.textSecondary }]}>{row.label}</Text>;
            }
            return renderNote(row.note);
          }}
          ListEmptyComponent={
            <View style={s.empty}>
              <Icon name="notes" size="lg" tone="muted" />
              <Text style={[s.emptyMsg, { color: theme.colors.textSecondary }]}>
                {search ? 'No notes found' : 'No notes yet'}
              </Text>
              {!search ? (
                <TouchableOpacity
                  style={[s.newBtnLg, { backgroundColor: theme.colors.accent }]}
                  onPress={() => void handleCreate()}
                  disabled={creating}
                >
                  <Text style={[s.newBtnText, { color: theme.colors.onAccent }]}>Create your first note</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          }
          contentContainerStyle={rows.length === 0 ? s.flex : undefined}
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headerTitle: { fontSize: 20, fontWeight: '700' },
    newBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 64,
    },
    newBtnDisabled: { opacity: 0.5 },
    newBtnText: { fontSize: 14, fontWeight: '600' },
    newBtnLg: {
      marginTop: 12,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 10,
    },
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    searchInput: { flex: 1, fontSize: 14 },
    sectionLabel: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 6,
    },
    noteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      gap: 10,
    },
    noteIcon: { fontSize: 20, width: 28, textAlign: 'center' },
    noteBody: { flex: 1 },
    noteTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 3,
    },
    noteMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    noteDate: { fontSize: 12 },
    sensBadge: { backgroundColor: '#fef3c7', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
    sensBadgeText: { fontSize: 10, fontWeight: '600', color: '#92400e' },
    favBtn: { padding: 4 },
    favStar: { fontSize: 18, color: theme.colors.textMuted },
    favStarActive: { color: '#f59e0b' },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 8 },
    emptyMsg: { fontSize: 16, fontWeight: '600', marginTop: 8 },
  });
}
