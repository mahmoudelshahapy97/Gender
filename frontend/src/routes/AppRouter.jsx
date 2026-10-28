import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout, Loading, RequireAuth } from "@insighteye/ui";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import ProductIcon from "@mui/icons-material/Wc";
import AppLayout from "../layouts/AppLayout";

// Code-split per route: the dashboard is the landing screen and has no business
// downloading the analytics charts before it can paint.
const Login = lazy(() => import("../pages/Login"));
const ForgotPassword = lazy(() => import("../pages/ForgotPassword"));
const Dashboard = lazy(() => import("../pages/Dashboard"));
const CameraList = lazy(() => import("../pages/cameras/CameraList"));
const CameraForm = lazy(() => import("../pages/cameras/CameraForm"));
const CameraDetail = lazy(() => import("../pages/cameras/CameraDetail"));
// Its own chunk, so chart.js is only downloaded by someone who opens it.
const Analytics = lazy(() => import("../pages/Analytics"));
const Visits = lazy(() => import("../pages/Visits"));
const Snapshots = lazy(() => import("../pages/Snapshots"));
const SystemStatus = lazy(() => import("../pages/SystemStatus"));
const Notifications = lazy(() => import("../pages/Notifications"));
const Users = lazy(() => import("../pages/admin/Users"));
const Workspaces = lazy(() => import("../pages/admin/Workspaces"));
const LiveWall = lazy(() => import("../pages/LiveWall"));
const AuditLog = lazy(() => import("../pages/admin/AuditLog"));
const NotFound = lazy(() => import("../pages/NotFound"));

export function AppRouter() {
  const { t } = useTranslation();
  const product = { brand: "InsightEye", tagline: t("product.tagline"), icon: <ProductIcon /> };
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading height="60vh" />}>
        <Routes>
          <Route element={<AuthLayout product={product} />}>
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
          </Route>

          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />

            <Route path="/cameras">
              <Route index element={<CameraList />} />
              <Route
                path="new"
                element={
                  <RequireAuth perm="admin">
                    <CameraForm />
                  </RequireAuth>
                }
              />
              <Route path=":cameraId" element={<CameraDetail />} />
              <Route
                path=":cameraId/edit"
                element={
                  <RequireAuth perm="admin">
                    <CameraForm />
                  </RequireAuth>
                }
              />
            </Route>

            <Route path="/analytics" element={<Analytics />} />
            <Route path="/visits" element={<Visits />} />
            <Route path="/snapshots" element={<Snapshots />} />
            <Route path="/system" element={<SystemStatus />} />
            <Route path="/notifications" element={<Notifications />} />

            <Route
              path="/workspaces"
              element={
                <RequireAuth perm="admin">
                  <Workspaces />
                </RequireAuth>
              }
            />

            <Route
              path="/users"
              element={
                <RequireAuth perm="admin">
                  <Users />
                </RequireAuth>
              }
            />

            <Route path="/live" element={<LiveWall />} />
            <Route
              path="/audit"
              element={
                <RequireAuth perm="admin">
                  <AuditLog />
                </RequireAuth>
              }
            />

            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRouter;
