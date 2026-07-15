import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/Layout';
import { UsersPage } from '@/pages/Users';
import { ThreadsPage } from '@/pages/Threads';
import { ApprovalsPage } from '@/pages/Approvals';
import { VenuesPage } from '@/pages/Venues';
import { DeliveryPage } from '@/pages/Delivery';
import { PopulatePage } from '@/pages/Populate';
import { TurnsPage } from '@/pages/Turns';
import { SettingsPage } from '@/pages/Settings';
import { Redirect } from 'wouter';

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={() => <Redirect to="/users" />} />
        <Route path="/users" component={UsersPage} />
        <Route path="/threads" component={ThreadsPage} />
        <Route path="/approvals" component={ApprovalsPage} />
        <Route path="/venues" component={VenuesPage} />
        <Route path="/delivery" component={DeliveryPage} />
        <Route path="/populate" component={PopulatePage} />
        <Route path="/turns" component={TurnsPage} />
        <Route path="/settings" component={SettingsPage} />
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
