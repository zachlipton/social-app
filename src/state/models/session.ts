import {makeAutoObservable} from 'mobx'
import {
  sessionClient as AtpApi,
  Session,
  SessionServiceClient,
  ComAtprotoServerGetAccountsConfig as GetAccountsConfig,
} from '@atproto/api'
import {isObj, hasProp} from '../lib/type-guards'
import {RootStoreModel} from './root-store'
import {isNetworkError} from '../../lib/errors'

export type ServiceDescription = GetAccountsConfig.OutputSchema

interface SessionData {
  service: string
  refreshJwt: string
  accessJwt: string
  handle: string
  did: string
}

export class SessionModel {
  data: SessionData | null = null
  online = false
  attemptingConnect = false
  private _connectPromise: Promise<void> | undefined

  constructor(public rootStore: RootStoreModel) {
    makeAutoObservable(this, {
      rootStore: false,
      serialize: false,
      hydrate: false,
    })
  }

  get hasSession() {
    return this.data !== null
  }

  serialize(): unknown {
    return {
      data: this.data,
    }
  }

  hydrate(v: unknown) {
    if (isObj(v)) {
      if (hasProp(v, 'data') && isObj(v.data)) {
        const data: SessionData = {
          service: '',
          refreshJwt: '',
          accessJwt: '',
          handle: '',
          did: '',
        }
        if (hasProp(v.data, 'service') && typeof v.data.service === 'string') {
          data.service = v.data.service
        }
        if (
          hasProp(v.data, 'refreshJwt') &&
          typeof v.data.refreshJwt === 'string'
        ) {
          data.refreshJwt = v.data.refreshJwt
        }
        if (
          hasProp(v.data, 'accessJwt') &&
          typeof v.data.accessJwt === 'string'
        ) {
          data.accessJwt = v.data.accessJwt
        }
        if (hasProp(v.data, 'handle') && typeof v.data.handle === 'string') {
          data.handle = v.data.handle
        }
        if (hasProp(v.data, 'did') && typeof v.data.did === 'string') {
          data.did = v.data.did
        }
        if (
          data.service &&
          data.refreshJwt &&
          data.accessJwt &&
          data.handle &&
          data.did
        ) {
          this.data = data
        }
      }
    }
  }

  clear() {
    this.data = null
    this.setOnline(false)
  }

  setState(data: SessionData) {
    this.data = data
  }

  setOnline(online: boolean, attemptingConnect?: boolean) {
    this.online = online
    if (typeof attemptingConnect === 'boolean') {
      this.attemptingConnect = attemptingConnect
    }
  }

  updateAuthTokens(session: Session) {
    if (this.data) {
      this.setState({
        ...this.data,
        accessJwt: session.accessJwt,
        refreshJwt: session.refreshJwt,
      })
    }
  }

  private configureApi(): boolean {
    if (!this.data) {
      return false
    }

    try {
      const serviceUri = new URL(this.data.service)
      this.rootStore.api.xrpc.uri = serviceUri
    } catch (e) {
      console.error(
        `Invalid service URL: ${this.data.service}. Resetting session.`,
      )
      console.error(e)
      this.clear()
      return false
    }

    this.rootStore.api.sessionManager.set({
      refreshJwt: this.data.refreshJwt,
      accessJwt: this.data.accessJwt,
    })
    return true
  }

  async connect(): Promise<void> {
    if (this._connectPromise) {
      return this._connectPromise
    }
    this._connectPromise = this._connect()
    await this._connectPromise
    this._connectPromise = undefined
  }

  private async _connect(): Promise<void> {
    this.attemptingConnect = true
    if (!this.configureApi()) {
      return
    }

    try {
      const sess = await this.rootStore.api.com.atproto.session.get()
      if (sess.success && this.data && this.data.did === sess.data.did) {
        this.setOnline(true, false)
        if (this.rootStore.me.did !== sess.data.did) {
          this.rootStore.me.clear()
        }
        this.rootStore.me.load().catch(e => {
          console.error('Failed to fetch local user information', e)
        })
        return // success
      }
    } catch (e: any) {
      if (isNetworkError(e)) {
        this.setOnline(false, false) // connection issue
        return
      } else {
        this.clear() // invalid session cached
      }
    }

    this.setOnline(false, false)
  }

  async describeService(service: string): Promise<ServiceDescription> {
    const api = AtpApi.service(service) as SessionServiceClient
    const res = await api.com.atproto.server.getAccountsConfig({})
    return res.data
  }

  async login({
    service,
    handle,
    password,
  }: {
    service: string
    handle: string
    password: string
  }) {
    const api = AtpApi.service(service) as SessionServiceClient
    const res = await api.com.atproto.session.create({handle, password})
    if (res.data.accessJwt && res.data.refreshJwt) {
      this.setState({
        service: service,
        accessJwt: res.data.accessJwt,
        refreshJwt: res.data.refreshJwt,
        handle: res.data.handle,
        did: res.data.did,
      })
      this.configureApi()
      this.setOnline(true, false)
      this.rootStore.me.load().catch(e => {
        console.error('Failed to fetch local user information', e)
      })
    }
  }

  async createAccount({
    service,
    email,
    password,
    handle,
    inviteCode,
  }: {
    service: string
    email: string
    password: string
    handle: string
    inviteCode?: string
  }) {
    const api = AtpApi.service(service) as SessionServiceClient
    const res = await api.com.atproto.account.create({
      handle,
      password,
      email,
      inviteCode,
    })
    if (res.data.accessJwt && res.data.refreshJwt) {
      this.setState({
        service: service,
        accessJwt: res.data.accessJwt,
        refreshJwt: res.data.refreshJwt,
        handle: res.data.handle,
        did: res.data.did,
      })
      this.rootStore.onboard.start()
      this.configureApi()
      this.rootStore.me.load().catch(e => {
        console.error('Failed to fetch local user information', e)
      })
    }
  }

  async logout() {
    if (this.hasSession) {
      this.rootStore.api.com.atproto.session.delete().catch((e: any) => {
        console.error('(Minor issue) Failed to delete session on the server', e)
      })
    }
    this.rootStore.clearAll()
  }
}
