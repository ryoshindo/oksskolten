import { useNavigate } from 'react-router-dom'
import useSWR from 'swr'
import { Settings, Sun, Moon, Monitor, Palette, LogOut, Check } from 'lucide-react'
import { useI18n } from '../../lib/i18n'
import { fetcher } from '../../lib/fetcher'
import { logoutClient } from '../../lib/auth'
import { Avatar } from '../settings/avatar-picker'
import { useAppLayout } from '../../app'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu'

type ColorMode = 'light' | 'dark' | 'system'

interface SidebarMenuProps {
  onClose: () => void
}

export function SidebarMenu({ onClose }: SidebarMenuProps) {
  const { settings } = useAppLayout()
  const { colorMode, setColorMode, themeName, setTheme, themes } = settings
  const navigate = useNavigate()
  const { t } = useI18n()
  const { data: profile } = useSWR<{ account_name: string; avatar_seed: string | null; email: string }>('/api/settings/profile', fetcher)

  const accountName = profile?.account_name || ''
  const email = profile?.email || ''

  const CurrentIcon = colorMode === 'light' ? Sun : colorMode === 'dark' ? Moon : Monitor
  const currentLabel = colorMode === 'light'
    ? t('settings.colorModeLight')
    : colorMode === 'dark'
      ? t('settings.colorModeDark')
      : t('settings.colorModeAuto')

  const currentThemeLabel = themes.find(th => th.name === themeName)?.label ?? themeName

  const modes: { value: ColorMode; label: string; Icon: typeof Sun }[] = [
    { value: 'light', label: t('settings.colorModeLight'), Icon: Sun },
    { value: 'dark', label: t('settings.colorModeDark'), Icon: Moon },
    { value: 'system', label: t('settings.colorModeAuto'), Icon: Monitor },
  ]

  return (
    <div className="border-t border-border px-2 py-2 shrink-0 select-none">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="w-full text-left px-2 py-1.5 rounded-lg text-sm text-text flex items-center gap-2.5 hover:bg-hover-sidebar transition-colors outline-none"
          >
            <Avatar seed={profile?.avatar_seed ?? null} name={accountName} sizeClass="w-7 h-7" textClass="text-xs" />
            <span className="truncate">{accountName}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          {email && (
            <div className="px-3.5 py-2 text-xs text-muted truncate">{email}</div>
          )}
          <DropdownMenuItem
            onSelect={() => { void navigate('/settings/general'); onClose() }}
          >
            <Settings size={16} strokeWidth={1.5} />
            {t('sidebar.settings')}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <CurrentIcon size={16} strokeWidth={1.5} />
              <span className="flex-1">{currentLabel}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {modes.map(({ value, label, Icon }) => (
                <DropdownMenuItem
                  key={value}
                  onSelect={() => setColorMode(value)}
                  className={colorMode === value ? 'text-accent' : ''}
                >
                  <Icon size={14} strokeWidth={1.5} />
                  {label}
                  {colorMode === value && <Check size={14} className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Palette size={16} strokeWidth={1.5} />
              <span className="flex-1">{currentThemeLabel}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {themes.map(theme => (
                <DropdownMenuItem
                  key={theme.name}
                  onSelect={() => setTheme(theme.name)}
                  className={themeName === theme.name ? 'text-accent' : ''}
                >
                  {theme.label}
                  {themeName === theme.name && <Check size={14} className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={async () => {
              await fetch('/api/logout', { method: 'POST' }).catch(() => {})
              logoutClient()
            }}
          >
            <LogOut size={16} strokeWidth={1.5} />
            {t('sidebar.logout')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
