export type {
  AuthUser,
  ExtensionRequest,
  FileRecord,
  FileListItem,
  FileListResult,
  FileListCounts,
  FileDetails,
  FilePreview,
  FileSort,
  FileTypeFilter,
  Folder,
  FolderStats,
  BulkFileResult,
  LifecycleJob,
  MemberRole,
  Notification,
  PendingInviteView,
  JoinRequestView,
  MembersPayload,
  SpaceJoinPreview,
  Profile,
  Space,
  SpaceDetail,
  SpaceStorageBreakdown,
  SpaceSort,
  SpaceListQuery,
  SpaceTemplate,
  DuplicateSpaceResult,
  SpaceMember,
  SpaceStatus,
  StorageSummary,
  AdminStats,
  AdminOverview,
  AdminHealth,
  AdminHealthCheck,
  AdminJobRow,
  AdminJobDetail,
  AdminCleanupRow,
  AdminAuditEntry,
  AdminAuditPage,
  AdminAnalytics,
  AdminAnalyticsBucket,
  AdminUserRow,
  AdminUserPage,
  AdminUserDetail,
  AccountStatus,
  ActivityLog,
  ActivityPage,
  ActivityQuery,
  ActivityCategory,
  ActivityActorType,
  ActivityOutcome,
  DashboardSummary,
  DashboardActivityItem,
  DashboardFileItem,
  DashboardSpaceItem,
  DashboardInvitationItem,
  DashboardExpiryItem,
  DashboardCounts,
  SearchResults,
  SearchResultItem,
  SearchCategory,
} from '@flashspace/shared';

export type { JoinRequest, SpaceInviteLink } from '@flashspace/shared';

import type { Archive } from '@flashspace/shared';
export type { Archive };

// Smart Storage Insights + Duplicate Detection
export type {
  ScanJob,
  ScanStatus,
  PlanStatus,
  ArchiveJobStatus,
  DuplicateGroup,
  DuplicateFile,
  NearDuplicateGroup,
  NearDuplicateFile,
  ArchivePlan,
  ArchiveJob,
  UnscannedFile,
  LargeFile,
  StorageInsights,
  CreatePlanInput,
  UpdatePlanInput,
  PlanReview,
} from '@flashspace/shared';

// Vault + Archive management
export interface ArchiveDetail {
  archive: Archive;
  spaceName: string | null;
  spaceStatus: string | null;
  ownerName: string | null;
}
export interface ArchiveFile {
  fileId: string;
  name: string;
  path: string;
  folderPath: string | null;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
}
export interface ArchiveFileListing {
  files: ArchiveFile[];
  manifestVerified: boolean;
}
export interface VerificationCheck {
  name: string;
  passed: boolean;
  message?: string;
  details?: string;
}
export interface ArchiveVerification {
  archive: Archive;
  verified: boolean;
  checks: VerificationCheck[];
}
export interface VaultFilteredResult {
  archives: Archive[];
  total: number;
}
