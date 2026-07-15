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
