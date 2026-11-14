import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for the Module 16 audit finding: mounting the Files tab used
 * to fire an unbounded request loop because `refresh` depended on the parent's
 * inline `onChanged` callback. A re-render recreated the callback, re-ran the
 * effect and fetched again — hundreds of `/folders` calls per minute until 429.
 */

const mocks = vi.hoisted(() => ({
  listFolders: vi.fn(),
  folderStats: vi.fn(),
  listFileManager: vi.fn(),
  uploadConfig: vi.fn(),
  bulkMoveFiles: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    listFolders: mocks.listFolders,
    folderStats: mocks.folderStats,
    listFileManager: mocks.listFileManager,
    uploadConfig: mocks.uploadConfig,
    bulkMoveFiles: mocks.bulkMoveFiles,
  },
}));

vi.mock('../components/ToastProvider', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const { SpaceFiles } = await import('./SpaceFiles');

const emptyList = {
  files: [],
  total: 0,
  counts: { all: 0, image: 0, pdf: 0, document: 0, text: 0, other: 0 },
  limit: 50,
  offset: 0,
};

function renderFiles(onChanged: () => void) {
  return render(
    <SpaceFiles
      spaceId="space-1"
      canEdit
      readOnly={false}
      onChanged={onChanged}
      onOpenVault={() => undefined}
    />,
  );
}

describe('SpaceFiles data loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listFolders.mockResolvedValue({ folders: [] });
    mocks.folderStats.mockResolvedValue({
      stats: { folderId: null, fileCount: 0, folderCount: 0, usedBytes: 0 },
    });
    mocks.listFileManager.mockResolvedValue(emptyList);
    mocks.uploadConfig.mockResolvedValue({
      config: {
        maxUploadBytes: 50 * 1024 * 1024,
        maxSpaceBytes: 5 * 1024 * 1024 * 1024,
        blockedExtensions: [],
        defaultLimit: 50,
        maxLimit: 200,
      },
    });
  });

  it('sends an explicit destination when moving a file back to the Space root', async () => {
    const file = {
      id: 'file-1',
      spaceId: 'space-1',
      folderId: 'folder-1',
      uploaderId: 'user-1',
      name: 'qa-note.txt',
      objectKey: 'spaces/space-1/qa-note.txt',
      mimeType: 'text/plain',
      sizeBytes: 22,
      etag: null,
      sha256: null,
      status: 'ACTIVE' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      uploaderName: 'Olive Owner',
      folderPath: 'Docs/',
      previewKind: 'text' as const,
    };
    mocks.listFolders.mockResolvedValue({
      folders: [
        {
          id: 'folder-1',
          spaceId: 'space-1',
          parentId: null,
          name: 'Docs',
          path: 'Docs',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    mocks.listFileManager.mockResolvedValue({
      ...emptyList,
      files: [file],
      total: 1,
      counts: { ...emptyList.counts, all: 1, text: 1 },
    });
    mocks.bulkMoveFiles.mockResolvedValue({ succeeded: [{ id: 'file-1' }], failed: [] });

    renderFiles(() => undefined);
    await waitFor(() => expect(screen.getByText('qa-note.txt')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    const dialog = screen.getByRole('dialog');
    const select = within(dialog).getByLabelText('Destination folder') as HTMLSelectElement;
    // A preselected root would swallow the change event, making the move
    // impossible to submit from a folder.
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'root' } });

    await waitFor(() =>
      expect(mocks.bulkMoveFiles).toHaveBeenCalledWith('space-1', ['file-1'], null),
    );
  });

  it('loads once and does not refetch when the parent re-renders', async () => {
    const { rerender } = renderFiles(() => undefined);
    await waitFor(() => expect(screen.queryByText('Nothing here yet')).toBeInTheDocument());

    const folderCalls = mocks.listFolders.mock.calls.length;
    expect(folderCalls).toBe(1);
    expect(mocks.folderStats).toHaveBeenCalledTimes(1);
    expect(mocks.listFileManager).toHaveBeenCalledTimes(1);

    // Simulate the parent updating state and passing a brand-new closure, which
    // is exactly what SpaceDetail does after `load()` resolves.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        rerender(
          <SpaceFiles
            spaceId="space-1"
            canEdit
            readOnly={false}
            onChanged={() => undefined}
            onOpenVault={() => undefined}
          />,
        );
      });
    }

    expect(mocks.listFolders).toHaveBeenCalledTimes(folderCalls);
    expect(mocks.folderStats).toHaveBeenCalledTimes(1);
    expect(mocks.listFileManager).toHaveBeenCalledTimes(1);
  });
});
