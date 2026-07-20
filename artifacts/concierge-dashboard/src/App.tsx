import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, Redirect } from 'wouter';
import { Layout } from '@/components/Layout';
import { UsersPage } from '@/pages/Users';
import { ThreadsPage } from '@/pages/Threads';
import { VenuesPage } from '@/pages/Venues';
import { OperationsPage } from '@/pages/Operations';
import { SettingsPage } from '@/pages/Settings';
import { EmulatorPage } from '@/pages/Emulator';

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={() => <Redirect to="/users" />} />
        <Route path="/users" component={UsersPage} />
        <Route path="/threads" component={ThreadsPage} />
        <Route path="/venues" component={VenuesPage} />
        <Route path="/operations" component={OperationsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/emulator" component={EmulatorPage} />
        {/* Legacy redirects — preserve bookmarks and deep-links */}
        <Route path="/turns" component={() => <Redirect to="/threads?tab=turns" />} />
        <Route path="/populate" component={() => <Redirect to="/venues?tab=populate" />} />
        <Route path="/approvals" component={() => <Redirect to="/operations" />} />
        <Route path="/delivery" component={() => <Redirect to="/operations?tab=delivery" />} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
