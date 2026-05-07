import { FirebaseApp } from "firebase/app";
import {
  Auth,
  browserLocalPersistence,
  getAuth,
  initializeAuth,
} from "firebase/auth";
import { isLinux } from "./env.utils";

let _auth: Auth | null = null;

export const getEffectiveAuth = (): Auth => {
  if (!_auth) {
    throw new Error("Auth has not been initialized. Call createAuth first.");
  }

  return _auth;
};

export const createEffectiveAuth = (app: FirebaseApp): Auth => {
  if (_auth) {
    throw new Error("Auth has already been initialized.");
  }

  if (isLinux()) {
    _auth = initializeAuth(app, { persistence: browserLocalPersistence });
  } else {
    _auth = getAuth(app);
  }

  return getEffectiveAuth();
};
