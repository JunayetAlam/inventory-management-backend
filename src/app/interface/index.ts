import { UserRoleEnum } from '../../generated/prisma/client';

export type AuthUser = {
  id: string;
  email: string;
  role: UserRoleEnum;
  name: string;
  profilePhoto?: string;
};

declare global {
  namespace Express {
    interface Request {
      user: AuthUser;
      isPrivilegedAccess?: boolean;
    }
  }
}

export {};
