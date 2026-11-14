import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import AppsPage from "./components/apps/AppsPage.tsx";
import { PageLayout } from "./components/common/PageLayout.tsx";
import DashboardPage from "./components/dashboard/DashboardPage.tsx";
import DictionaryPage from "./components/dictionary/DictionaryPage.tsx";
import EnterpriseRoutingPage from "./components/enterprise/EnterpriseRoutingPage.tsx";
import HomePage from "./components/home/HomePage.tsx";
import LoginPage from "./components/login/LoginPage.tsx";
import NotePage from "./components/notes/NotePage.tsx";
import NotesPage from "./components/notes/NotesPage.tsx";
import OnboardingPage from "./components/onboarding/OnboardingPage.tsx";
import ErrorBoundary from "./components/root/ErrorBoundary.tsx";
import { AppHeader } from "./components/root/Header.tsx";
import { HeaderPortalProvider } from "./components/root/HeaderPortalContext.tsx";
import Root from "./components/root/Root.tsx";
import { Guard } from "./components/routing/Guard.tsx";
import { Redirect } from "./components/routing/Redirectors.tsx";
import SettingsPage from "./components/settings/SettingsPage.tsx";
import StylingPage from "./components/styling/StylingPage.tsx";
import TranscriptionsPage from "./components/transcriptions/TranscriptionsPage.tsx";
import WelcomePage from "./components/welcome/WelcomePage.tsx";

const AppWrapper = () => {
  return (
    <PageLayout header={<AppHeader />}>
      <Outlet />
    </PageLayout>
  );
};

export const browserRouter = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    errorElement: <ErrorBoundary />,
    children: [
      {
        index: true,
        element: <Redirect to="/dashboard" />,
      },
      {
        element: (
          <Guard node="welcome">
            <Outlet />
          </Guard>
        ),
        children: [
          {
            path: "welcome",
            element: <WelcomePage />,
          },
        ],
      },
      {
        element: (
          <Guard node="routing">
            <Outlet />
          </Guard>
        ),
        children: [
          {
            path: "routing",
            element: <EnterpriseRoutingPage />,
          },
        ],
      },
      {
        element: (
          <Guard node="welcome">
            <AppWrapper />
          </Guard>
        ),
        children: [
          {
            path: "login",
            element: <LoginPage />,
          },
        ],
      },
      {
        element: (
          <Guard node="onboarding">
            <AppWrapper />
          </Guard>
        ),
        children: [
          {
            path: "onboarding",
            element: <OnboardingPage />,
          },
        ],
      },
      {
        element: (
          <Guard node="dashboard">
            <AppWrapper />
          </Guard>
        ),
        children: [
          {
            path: "dashboard",
            element: <DashboardPage />,
            children: [
              {
                index: true,
                element: <HomePage />,
              },
              {
                path: "settings",
                element: <SettingsPage />,
              },
              {
                path: "transcriptions",
                element: <TranscriptionsPage />,
              },
              {
                path: "dictionary",
                element: <DictionaryPage />,
              },
              {
                path: "styling",
                element: <StylingPage />,
              },
              {
                path: "notes",
                element: <NotesPage />,
              },
              {
                path: "notes/:noteId",
                element: <NotePage />,
              },
              {
                path: "apps",
                element: <AppsPage />,
              },
            ],
          },
        ],
      },
    ],
  },
]);

export default function Router() {
  return (
    <HeaderPortalProvider>
      <RouterProvider router={browserRouter} />
    </HeaderPortalProvider>
  );
}
