export type TMaintenancePublicStatus = {
  isActive: boolean;
  title: string;
  message: string;
  reason: string | null;
  estimatedEndTime: Date | null;
  contactEmail: string | null;
  contactPhone: string | null;
  supportNotice: string | null;
  lastToggledAt: Date | null;
};

export type TUpdateMaintenancePayload = {
  title?: string;
  message?: string;
  reason?: string | null;
  estimatedEndTime?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  supportNotice?: string | null;
};

export type TToggleMaintenancePayload = {
  isActive: boolean;
};
