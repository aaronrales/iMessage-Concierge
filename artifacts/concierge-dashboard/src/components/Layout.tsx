import { Link, useLocation } from "wouter";
import { Users, MessageSquare, CheckSquare, ConciergeBell } from "lucide-react";
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
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={location === "/" || location === "/users"}>
                <Link href="/users">
                  <Users />
                  <span>Users</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={location.startsWith("/threads")}>
                <Link href="/threads">
                  <MessageSquare />
                  <span>Threads</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={location.startsWith("/approvals")}>
                <Link href="/approvals">
                  <CheckSquare />
                  <span>Approvals</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="flex flex-col min-h-screen bg-background overflow-hidden">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
