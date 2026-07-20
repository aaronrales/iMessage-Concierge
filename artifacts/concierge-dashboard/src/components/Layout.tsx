import { Link, useLocation } from "wouter";
import { Users, MessageSquare, ConciergeBell, UtensilsCrossed, Activity, Settings, Terminal } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarInset
} from "@/components/ui/sidebar";
import React from "react";

const NAV = [
  { href: "/users",      label: "Users",       Icon: Users,          match: (l: string) => l === "/" || l.startsWith("/users") },
  { href: "/threads",    label: "Threads",     Icon: MessageSquare,  match: (l: string) => l.startsWith("/threads") },
  { href: "/venues",     label: "Venues",      Icon: UtensilsCrossed,match: (l: string) => l.startsWith("/venues") },
  { href: "/operations", label: "Operations",  Icon: Activity,       match: (l: string) => l.startsWith("/operations") || l.startsWith("/approvals") || l.startsWith("/delivery") },
  { href: "/emulator",   label: "Emulator",    Icon: Terminal,       match: (l: string) => l.startsWith("/emulator") },
  { href: "/settings",   label: "Settings",    Icon: Settings,       match: (l: string) => l.startsWith("/settings") },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <SidebarProvider>
      <Sidebar variant="sidebar" className="border-r border-sidebar-border bg-sidebar">
        <SidebarHeader className="p-4 border-b border-sidebar-border/50">
          <div className="flex items-center gap-2 font-bold text-sidebar-primary tracking-tight">
            <div className="bg-sidebar-primary text-sidebar-primary-foreground p-1.5 rounded-md shadow-sm">
              <ConciergeBell className="h-5 w-5" />
            </div>
            <span>Concierge Ops</span>
          </div>
        </SidebarHeader>
        <SidebarContent className="p-2">
          <SidebarMenu>
            {NAV.map(({ href, label, Icon, match }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton asChild isActive={match(location)}>
                  <Link href={href}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="flex flex-col min-h-screen bg-background overflow-hidden">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
