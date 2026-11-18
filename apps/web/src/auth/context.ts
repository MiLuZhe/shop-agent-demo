import { createContext, useContext } from 'react';
import type { AuthUserDto } from '@shop/contracts';
export const AuthContext = createContext<{ user: AuthUserDto | null; pending: boolean }>({ user: null, pending: true });
export const useAuth = () => useContext(AuthContext);
